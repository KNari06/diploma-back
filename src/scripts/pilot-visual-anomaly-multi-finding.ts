/**
 * Pilot script (dev-only, not wired into any runtime path) — validates the
 * multi-finding visual-anomaly prompt (ADR-0016) BEFORE committing to the
 * parsing/DB changes built on top of it. Calls `generateTextWithGeminiVision`
 * directly with the real prompt from `visual-anomaly-prompts.ts` against a
 * handful of synthetic fixtures, two of which have two distinct injected
 * defects. Prints raw output, parsed findings, and per-call cost so the
 * ADR can cite real numbers instead of a guess.
 *
 * Run (from qai-backend):
 *   npx tsx src/scripts/pilot-visual-anomaly-multi-finding.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { generateTextWithGeminiVision } from '@/services/ai/core/gemini.service';
import { buildVisualAnomalyPrompt } from '@/ai/prompts/visual-anomaly-prompts';
import { MODEL_PRICING } from '@/services/core/token-calculator.service';
import { extractJson } from '@/services/testing/api/flow/ai-json.util';

const FIXTURE_DIR =
  '/private/tmp/claude-502/-Users-Darkhan-Developer-qaits-qait-2/376c56fa-d37a-4c7c-8905-39ca34e51dce/scratchpad/anomaly-fixtures/png';

const CASES = [
  { file: '22_compound_broken_image_plus_placeholder.png', expectedFindings: 2 },
  { file: '23_compound_overlap_plus_wrong_locale.png', expectedFindings: 2 },
  { file: '01_placeholder_text_obvious.png', expectedFindings: 1 },
  { file: '18_legit_empty_state.png', expectedFindings: 0 },
];

function costUSD(model: string, inputTokens: number, thinkingPlusOutputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  return (inputTokens / 1000) * pricing.input + (thinkingPlusOutputTokens / 1000) * pricing.output;
}

async function main() {
  const { system } = buildVisualAnomalyPrompt();
  const model = 'gemini-2.5-flash' as const;

  let totalCost = 0;

  for (const c of CASES) {
    const filePath = path.join(FIXTURE_DIR, c.file);
    if (!fs.existsSync(filePath)) {
      console.log(`SKIP ${c.file} — fixture not found at ${filePath}`);
      continue;
    }
    const base64 = fs.readFileSync(filePath).toString('base64');

    const start = Date.now();
    const response = await generateTextWithGeminiVision({
      prompt: system,
      imageBase64: base64,
      mimeType: 'image/png',
      model,
      temperature: 0,
      maxTokens: 8192,
      timeout: 45000,
    });
    const elapsedMs = Date.now() - start;

    const { inputTokens, outputTokens, totalTokens } = response.usage;
    // thinking tokens = totalTokens - inputTokens - outputTokens (invisible reasoning,
    // billed at the output rate — see token-calculator.service.ts MODEL_PRICING)
    const thinkingTokens = totalTokens - inputTokens - outputTokens;
    const billedOutputTokens = outputTokens + thinkingTokens;
    const cost = costUSD(model, inputTokens, billedOutputTokens);
    totalCost += cost;

    // extractJson (not a bare JSON.parse) — the production code this script
    // validates already documents Gemini wrapping its JSON in a ```json
    // fence, and every response in an earlier run of this script WAS fenced,
    // which made a bare JSON.parse misreport every case as PARSE_FAILED.
    let parsedFindingsCount: number | 'PARSE_FAILED' = 'PARSE_FAILED';
    let parsedCategories: string[] = [];
    const parsed = extractJson(response.content);
    if (Array.isArray(parsed?.findings)) {
      parsedFindingsCount = parsed.findings.length;
      parsedCategories = parsed.findings.map((f: any) => f?.category);
    }

    console.log('─'.repeat(80));
    console.log(`FILE: ${c.file}  (expected ~${c.expectedFindings} findings)`);
    console.log(`elapsedMs=${elapsedMs} inputTokens=${inputTokens} outputTokens=${outputTokens} thinkingTokens=${thinkingTokens} totalTokens=${totalTokens}`);
    console.log(`costUSD=${cost.toFixed(5)}`);
    console.log(`parsedFindingsCount=${parsedFindingsCount} categories=${JSON.stringify(parsedCategories)}`);
    console.log(`RAW RESPONSE:\n${response.content}`);
  }

  console.log('─'.repeat(80));
  console.log(`TOTAL COST for ${CASES.length} calls: $${totalCost.toFixed(5)} (avg $${(totalCost / CASES.length).toFixed(5)}/call)`);
}

main().catch((err) => {
  console.error('Pilot script failed:', err);
  process.exit(1);
});
