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

  const sourceDir = path.join(process.cwd(), 'data/global-kb/sources');
  const outputPath = path.join(process.cwd(), 'data/global-kb/embeddings.json');

  // Check if source directory exists
  try {
    await fs.access(sourceDir);
  } catch {
    console.error(`❌ Source directory not found: ${sourceDir}`);
    process.exit(1);
  }

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

  const mdFiles = await findMarkdownFiles(sourceDir);

  if (mdFiles.length === 0) {
    console.error('❌ No markdown files found in sources directory');
    process.exit(1);
  }

  console.log(`📄 Found ${mdFiles.length} markdown files:`);
  mdFiles.forEach((f) => console.log(`   - ${f}`));
  console.log('');

  // Process each file
  const allChunks: Array<Chunk & { source_file: string }> = [];

  for (const file of mdFiles) {
    console.log(`📖 Processing ${file}...`);
    const filePath = path.join(sourceDir, file);
    const content = await fs.readFile(filePath, 'utf-8');

    const chunks = chunkMarkdown(content, file);
    console.log(`   ✓ Created ${chunks.length} chunks`);

    allChunks.push(
      ...chunks.map((c) => ({
        ...c,
        source_file: file,
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
  console.log(`   - Files: ${mdFiles.length}`);
  console.log(`   - Chunks: ${kb.chunks.length}`);
  console.log(`   - Model: ${kb.model}`);
  console.log(`   - Size: ${(Buffer.byteLength(JSON.stringify(kb)) / 1024 / 1024).toFixed(2)} MB\n`);

  // Print statistics
  const tagStats = new Map<string, number>();
  kb.chunks.forEach((chunk) => {
    chunk.tags?.forEach((tag) => {
      tagStats.set(tag, (tagStats.get(tag) || 0) + 1);
    });
  });

  console.log('📊 Tag distribution:');
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
