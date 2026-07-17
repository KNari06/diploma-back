/**
 * Probe-phase network driver (Phase 4b). Opt-in: with the user's consent, walks
 * the built DAG in execution order and CALLS each safe endpoint (GET reads,
 * login) once, observing the real response to correct extraction jsonPaths that
 * the spec's schema got wrong. Observed values are threaded into a per-probe
 * context so a later authed GET carries the token an earlier login produced.
 *
 * Strictly best-effort: any failure is swallowed — a probe never fails the build.
 * All HTTP goes through executeApiTest, which validates the URL (blocks
 * localhost / private IPs) before dialing, so the probe can't be turned into an
 * SSRF vector by a malicious spec.
 */

import type { ApiTestResponse } from '@/types';
import { logger } from '@/utils/core/logger';
import { executeApiTest } from '../apiTest.service';
// NOTE: accessed lazily inside runProbe (not destructured at module load) —
// flow-executor → flow-builder → probe-runner is a require cycle, so this
// module's top level must not touch flow-executor's exports.
import { __testables as executorTestables } from './flow-executor.service';
import { isSafeToProbe, correctExtraction, type ExtractionCorrection } from './wiring/probe';
import type { ExecutionDAG, ParsedApiSpec, VariableContext } from './flow.types';

const PROBE_TIMEOUT_MS = 8000;

export interface ProbeResult {
  corrections: ExtractionCorrection[];
  endpointsProbed: number;
}

/**
 * Probe safe endpoints and patch corrected jsonPaths INTO `dag.nodes` in place.
 * `seedCtx` carries build-time credentials the user supplied (base url, login body).
 */
export async function runProbe(
  dag: ExecutionDAG,
  spec: ParsedApiSpec,
  seedCtx: VariableContext,
): Promise<ProbeResult> {
  const { buildResolvedRequest, extractVariable } = executorTestables;
  const baseUrl = spec.baseUrl;
  const ctx: VariableContext = { ...seedCtx };
  const corrections: ExtractionCorrection[] = [];
  let endpointsProbed = 0;

  for (const id of dag.executionOrder) {
    const node = dag.nodes.find(n => n.id === id);
    if (!node || !isSafeToProbe(node) || node.variableExtractions.length === 0) continue;

    let resp: ApiTestResponse;
    try {
      const { resolvedUrl, resolvedHeaders, resolvedBody } = buildResolvedRequest(node, baseUrl, ctx);
      resp = await executeApiTest({
        method: node.method,
        url: resolvedUrl,
        headers: resolvedHeaders,
        body: resolvedBody,
        timeout: PROBE_TIMEOUT_MS,
      });
    } catch (err) {
      logger.debug('[PROBE] request failed, skipping node', { nodeId: id, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    endpointsProbed++;
    if (!resp.success || resp.responseBody === null || resp.responseBody === undefined) continue;

    for (const ext of node.variableExtractions) {
      // Correct a wrong jsonPath from what the response actually contains.
      const fix = correctExtraction(resp.responseBody, ext);
      if (fix) {
        ext.jsonPath = fix.extraction.jsonPath; // patch the DAG node in place
        corrections.push(fix.correction);
        logger.info('[PROBE] corrected extraction path', { nodeId: id, ...fix.correction });
      }
      // Thread the observed value forward so downstream authed probes work.
      const value = extractVariable(resp.responseBody, resp.responseHeaders || {}, ext);
      if (value !== undefined) ctx[ext.variableName] = value;
    }
  }

  logger.info('[PROBE] completed', { endpointsProbed, corrections: corrections.length });
  return { corrections, endpointsProbed };
}
