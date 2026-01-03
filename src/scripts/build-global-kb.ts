/**
 * Build script to generate global KB embeddings from markdown files
 *
 * Usage:
 *   npm run build-kb
 *   or
 *   ts-node -r tsconfig-paths/register src/scripts/build-global-kb.ts
 */

import { generateEmbeddings } from '@/services/ai/core/embedding.service';
import { chunkMarkdown } from '@/utils/text-processing/chunking';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

// Constants
const MAX_FILE_SIZE_MB = 10; // Maximum file size to process
const MAX_CHUNKS_BATCH = 100; // Maximum chunks to process in one batch (OpenAI limit)
const MAX_TOTAL_CHUNKS = 10000; // Maximum total chunks to prevent memory issues

interface Chunk {
  content: string;
  metadata: any;
  chunkIndex: number;
  totalChunks: number;
  tokenCount?: number;
}

async function buildGlobalKB() {
  console.log('🚀 Building Global KB...\n');

  const globalKbRoot = path.join(process.cwd(), 'data/global-kb');
  const outputPath = path.join(globalKbRoot, 'embeddings.json');

  // Define source directories to scan
  const sourceDirs = [
    { path: path.join(globalKbRoot, 'sources'), language: 'neutral' },
    { path: path.join(globalKbRoot, 'en'), language: 'en' },
    { path: path.join(globalKbRoot, 'ru'), language: 'ru' },
  ];

  // Check if at least one source directory exists
  const existingDirs = [];
  for (const dir of sourceDirs) {
    try {
      await fs.access(dir.path);
      existingDirs.push(dir);
      console.log(`✓ Found directory: ${path.relative(globalKbRoot, dir.path)} (${dir.language})`);
    } catch {
      console.warn(`⚠️ Directory not found: ${path.relative(globalKbRoot, dir.path)}`);
    }
  }

  if (existingDirs.length === 0) {
    console.error('❌ No source directories found');
    process.exit(1);
  }

  console.log('');

  // Recursively find all markdown files
  async function findMarkdownFiles(dir: string, baseDir: string = dir): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files: string[] = [];

      for (const entry of entries) {
        try {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            // Recursively search subdirectories
            const subFiles = await findMarkdownFiles(fullPath, baseDir);
            files.push(...subFiles);
          } else if (entry.name.endsWith('.md')) {
            // Store relative path from baseDir
            const relativePath = path.relative(baseDir, fullPath);
            files.push(relativePath);
          }
        } catch (error) {
          console.warn(`⚠️ Skipping entry ${entry.name}:`, error instanceof Error ? error.message : String(error));
          continue;
        }
      }

      return files;
    } catch (error) {
      console.error(`❌ Error reading directory ${dir}:`, error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  // Collect all files from all source directories
  const allFiles: Array<{ file: string; language: string; baseDir: string }> = [];

  for (const dir of existingDirs) {
    const files = await findMarkdownFiles(dir.path);

    for (const file of files) {
      allFiles.push({
        file,
        language: dir.language,
        baseDir: dir.path,
      });
    }
  }

  if (allFiles.length === 0) {
    console.error('❌ No markdown files found in any source directory');
    process.exit(1);
  }

  console.log(`📄 Found ${allFiles.length} markdown files:`);

  // Group by language for display
  const byLanguage = allFiles.reduce((acc, f) => {
    if (!acc[f.language]) acc[f.language] = [];
    acc[f.language].push(f.file);
    return acc;
  }, {} as Record<string, string[]>);

  for (const [lang, files] of Object.entries(byLanguage)) {
    console.log(`\n  [${lang}]:`);
    files.forEach((f) => console.log(`   - ${f}`));
  }
  console.log('');

  // Process each file
  const allChunks: Array<Chunk & { source_file: string; language: string }> = [];

  for (const fileInfo of allFiles) {
    try {
      console.log(`📖 Processing [${fileInfo.language}] ${fileInfo.file}...`);
      const filePath = path.join(fileInfo.baseDir, fileInfo.file);

      // Check file size before reading
      const stats = await fs.stat(filePath);
      const fileSizeMB = stats.size / (1024 * 1024);

      if (fileSizeMB > MAX_FILE_SIZE_MB) {
        console.warn(`   ⚠️ Skipping file: size (${fileSizeMB.toFixed(2)} MB) exceeds limit (${MAX_FILE_SIZE_MB} MB)`);
        continue;
      }

      // Read file content
      const content = await fs.readFile(filePath, 'utf-8');

      if (!content || content.trim().length === 0) {
        console.warn(`   ⚠️ Skipping empty file: ${fileInfo.file}`);
        continue;
      }

      // Chunk markdown content
      const chunks = chunkMarkdown(content, fileInfo.file);

      if (!chunks || chunks.length === 0) {
        console.warn(`   ⚠️ No chunks created from file: ${fileInfo.file}`);
        continue;
      }

      // Filter out empty chunks
      const validChunks = chunks.filter((c) => c.content && c.content.trim().length > 0);

      if (validChunks.length === 0) {
        console.warn(`   ⚠️ No valid chunks in file: ${fileInfo.file}`);
        continue;
      }

      console.log(`   ✓ Created ${validChunks.length} chunks`);

      allChunks.push(
        ...validChunks.map((c) => ({
          ...c,
          source_file: `${fileInfo.language}/${fileInfo.file}`,
          language: fileInfo.language,
        }))
      );

      // Check total chunks limit
      if (allChunks.length > MAX_TOTAL_CHUNKS) {
        console.warn(`\n⚠️ Total chunks (${allChunks.length}) exceeds limit (${MAX_TOTAL_CHUNKS}). Stopping processing.`);
        break;
      }
    } catch (error) {
      console.error(`   ❌ Error processing file ${fileInfo.file}:`, error instanceof Error ? error.message : String(error));
      continue;
    }
  }

  if (allChunks.length === 0) {
    console.error('❌ No valid chunks found to process');
    process.exit(1);
  }

  console.log(`\n📊 Total chunks: ${allChunks.length}`);
  console.log('🧠 Generating embeddings...');

  // Generate embeddings in batches (OpenAI has limits)
  const chunkContents = allChunks.map((c) => c.content);
  const embeddings: number[][] = [];

  try {
    // Split into batches if needed
    if (chunkContents.length > MAX_CHUNKS_BATCH) {
      console.log(`   ℹ️ Processing ${chunkContents.length} chunks in batches of ${MAX_CHUNKS_BATCH}...`);

      for (let i = 0; i < chunkContents.length; i += MAX_CHUNKS_BATCH) {
        const batch = chunkContents.slice(i, i + MAX_CHUNKS_BATCH);
        console.log(`   📦 Processing batch ${Math.floor(i / MAX_CHUNKS_BATCH) + 1}/${Math.ceil(chunkContents.length / MAX_CHUNKS_BATCH)}...`);

        const batchEmbeddings = await generateEmbeddings(batch);
        embeddings.push(...batchEmbeddings);

        // Small delay between batches to avoid rate limits
        if (i + MAX_CHUNKS_BATCH < chunkContents.length) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } else {
      // Single batch
      const batchEmbeddings = await generateEmbeddings(chunkContents);
      embeddings.push(...batchEmbeddings);
    }

    // Validate embeddings count matches chunks count
    if (embeddings.length !== allChunks.length) {
      throw new Error(
        `Embeddings count mismatch: expected ${allChunks.length}, got ${embeddings.length}`
      );
    }

    // Validate each embedding has correct dimensions (1536 for text-embedding-3-small)
    const invalidEmbeddings = embeddings.filter((emb) => !emb || !Array.isArray(emb) || emb.length !== 1536);
    if (invalidEmbeddings.length > 0) {
      throw new Error(`Invalid embeddings found: ${invalidEmbeddings.length} embeddings have incorrect dimensions`);
    }

    console.log('✓ Embeddings generated\n');
  } catch (error) {
    console.error('❌ Failed to generate embeddings:', error instanceof Error ? error.message : String(error));
    throw error;
  }

  // Extract tags from content (simple keyword extraction)
  function extractTags(content: string): string[] {
    if (!content || typeof content !== 'string') {
      return [];
    }

    const keywords = [
      // API & HTTP
      'api',
      'http',
      'https',
      'rest',
      'graphql',
      'get',
      'post',
      'delete',
      'put',
      'patch',
      'request',
      'response',
      'status',
      'headers',
      'body',
      'endpoint',

      // Testing & QA
      'testing',
      'test',
      'qa',
      'quality',
      'e2e',
      'end-to-end',
      'integration',
      'automated',
      'manual',
      'assert',
      'expect',
      'verify',
      'check',
      'assertion',

      // Playwright & Browsers
      'playwright',
      'browser',
      'chrome',
      'firefox',
      'safari',
      'edge',
      'webkit',
      'mobile',
      'ios',
      'android',
      'device',
      'viewport',

      // UI Elements
      'ui',
      'user-interface',
      'form',
      'button',
      'input',
      'select',
      'dropdown',
      'checkbox',
      'radio',
      'link',
      'text',
      'label',
      'selector',
      'xpath',
      'css',
      'id',
      'class',

      // Actions & Navigation
      'click',
      'type',
      'fill',
      'submit',
      'navigate',
      'goto',
      'wait',
      'timeout',
      'loading',
      'async',
      'promise',

      // Screenshots & Visual
      'screenshot',
      'image',
      'visual',
      'snapshot',
      'video',
      'trace',
      'recording',

      // Network & Performance
      'network',
      'performance',
      'speed',
      'latency',
      'bandwidth',
      'cache',
      'cors',

      // Security
      'authentication',
      'authorization',
      'security',
      'xss',
      'csrf',
      'sql-injection',
      'token',
      'jwt',
      'oauth',
      'session',

      // Data & Formats
      'data',
      'json',
      'xml',
      'csv',
      'database',
      'db',
      'sql',
      'query',

      // Errors & Debugging
      'error',
      'exception',
      'bug',
      'issue',
      'debug',
      'log',
      'console',
      'stack',

      // Validation & Checks
      'validation',
      'validate',
      'required',
      'optional',
      'format',
      'pattern',
      'regex',

      // AI & ML
      'ai',
      'artificial-intelligence',
      'machine-learning',
      'gpt',
      'openai',
      'embedding',
      'vector',
      'rag',
      'semantic',

      // CI/CD & DevOps
      'ci',
      'cd',
      'pipeline',
      'deploy',
      'deployment',
      'environment',
      'staging',
      'production',
      'dev',
      'development',

      // Configuration
      'config',
      'configuration',
      'setting',
      'option',
      'parameter',
      'env',

      // WebSocket & Real-time
      'websocket',
      'ws',
      'realtime',
      'socket',
      'connection',

      // Reporting & Analytics
      'report',
      'result',
      'summary',
      'analytics',
      'statistics',
      'metrics',

      // Accessibility
      'accessibility',
      'a11y',
      'wcag',
      'aria',
      'screen-reader',
    ];

    const contentLower = content.toLowerCase();
    const foundTags = keywords.filter((keyword) => contentLower.includes(keyword));

    // Deduplicate tags (in case of duplicates)
    return Array.from(new Set(foundTags));
  }

  // Build final KB structure
  const kb = {
    version: '1.0.0',
    model: 'text-embedding-3-small',
    generated_at: new Date().toISOString(),
    chunks: allChunks.map((chunk, idx) => {
      // Validate embedding exists
      if (!embeddings[idx] || !Array.isArray(embeddings[idx])) {
        throw new Error(`Missing or invalid embedding at index ${idx}`);
      }

      return {
        id: `chunk_${idx.toString().padStart(4, '0')}`,
        content: chunk.content,
        embedding: embeddings[idx],
        source_file: chunk.source_file,
        language: chunk.language,
        tags: extractTags(chunk.content),
        metadata: {
          chunkIndex: chunk.chunkIndex,
          totalChunks: chunk.totalChunks,
          tokenCount: chunk.tokenCount,
          ...(chunk.metadata || {}),
        },
      };
    }),
  };

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  try {
    await fs.mkdir(outputDir, { recursive: true });
  } catch (error) {
    console.error(`❌ Failed to create output directory ${outputDir}:`, error instanceof Error ? error.message : String(error));
    throw error;
  }

  // Save to file
  try {
    await fs.writeFile(outputPath, JSON.stringify(kb, null, 2), 'utf-8');
  } catch (error) {
    console.error(`❌ Failed to write output file ${outputPath}:`, error instanceof Error ? error.message : String(error));
    throw error;
  }

  console.log('💾 Saved to:', outputPath);
  console.log(`\n✅ Global KB built successfully!`);
  console.log(`   - Files: ${allFiles.length}`);
  console.log(`   - Chunks: ${kb.chunks.length}`);
  console.log(`   - Model: ${kb.model}`);
  console.log(`   - Size: ${(Buffer.byteLength(JSON.stringify(kb)) / 1024 / 1024).toFixed(2)} MB\n`);

  // Print language statistics
  const languageStats = new Map<string, number>();
  kb.chunks.forEach((chunk) => {
    languageStats.set(chunk.language, (languageStats.get(chunk.language) || 0) + 1);
  });

  console.log('🌐 Language distribution:');
  Array.from(languageStats.entries())
    .sort((a, b) => b[1] - a[1])
    .forEach(([lang, count]) => {
      const percentage = ((count / kb.chunks.length) * 100).toFixed(1);
      console.log(`   ${lang}: ${count} chunks (${percentage}%)`);
    });

  // Print tag statistics
  const tagStats = new Map<string, number>();
  kb.chunks.forEach((chunk) => {
    chunk.tags?.forEach((tag) => {
      tagStats.set(tag, (tagStats.get(tag) || 0) + 1);
    });
  });

  console.log('\n📊 Tag distribution:');
  Array.from(tagStats.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([tag, count]) => {
      console.log(`   ${tag}: ${count}`);
    });
}

// Run if called directly
if (require.main === module) {
  buildGlobalKB()
    .then(() => {
      console.log('\n🎉 Done!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Error:', error);
      process.exit(1);
    });
}

export { buildGlobalKB };
