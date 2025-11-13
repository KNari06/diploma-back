/**
 * Build script to generate global KB embeddings from markdown files
 *
 * Usage:
 *   npm run build-kb
 *   or
 *   ts-node -r tsconfig-paths/register src/scripts/build-global-kb.ts
 */

import { generateEmbeddings } from '@/services/ai/embedding.service';
import { chunkMarkdown } from '@/utils/chunking';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

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
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
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
    }

    return files;
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
    console.log(`📖 Processing [${fileInfo.language}] ${fileInfo.file}...`);
    const filePath = path.join(fileInfo.baseDir, fileInfo.file);
    const content = await fs.readFile(filePath, 'utf-8');

    const chunks = chunkMarkdown(content, fileInfo.file);
    console.log(`   ✓ Created ${chunks.length} chunks`);

    allChunks.push(
      ...chunks.map((c) => ({
        ...c,
        source_file: `${fileInfo.language}/${fileInfo.file}`,
        language: fileInfo.language,
      }))
    );
  }

  console.log(`\n📊 Total chunks: ${allChunks.length}`);
  console.log('🧠 Generating embeddings...');

  // Generate embeddings in batch
  const embeddings = await generateEmbeddings(allChunks.map((c) => c.content));

  console.log('✓ Embeddings generated\n');

  // Extract tags from content (simple keyword extraction)
  function extractTags(content: string): string[] {
    const keywords = [
      'api',
      'testing',
      'playwright',
      'qa',
      'http',
      'get',
      'post',
      'delete',
      'put',
      'patch',
      'authentication',
      'authorization',
      'validation',
      'error',
      'performance',
      'ui',
      'form',
      'button',
      'input',
    ];

    const contentLower = content.toLowerCase();
    return keywords.filter((keyword) => contentLower.includes(keyword));
  }

  // Build final KB structure
  const kb = {
    version: '1.0.0',
    model: 'text-embedding-3-small',
    generated_at: new Date().toISOString(),
    chunks: allChunks.map((chunk, idx) => ({
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
    })),
  };

  // Save to file
  await fs.writeFile(outputPath, JSON.stringify(kb, null, 2));

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
