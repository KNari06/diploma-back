/**
 * Phase 2.5 leak-coverage: EditorTraceService must redact `secrets.*`
 * values before persisting `step_apply_request` / `step_apply_result`.
 */

import * as fs from 'fs';

import { EditorTraceService } from '../editor-trace.service';
import type { PreviewIntentStep } from '@/websocket/types/types';

// Drive the redactor through the public setRunVariablesProvider hook so
// the lazy require in `getOrCreate` is bypassed (it would try to hit
// preview-session.service which we don't want to spin up in unit tests).
function build(sessionId: string, runVariables: Map<string, unknown>): EditorTraceService {
  const trace = EditorTraceService.getOrCreate(sessionId, 'u');
  trace.setRunVariablesProvider(() => runVariables);
  return trace;
}

async function close(sessionId: string): Promise<string | null> {
  const meta = await EditorTraceService.close(sessionId);
  return meta?.filePath ?? null;
}

function readAll(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

describe('EditorTraceService redaction', () => {
  it('redacts secret values inside step_apply_request payload', async () => {
    const id = `test_${Date.now()}_a`;
    const map = new Map<string, unknown>([['secrets.STRIPE', 'sk_test_LEAK_VALUE']]);
    const trace = build(id, map);

    trace.writeStepApplyRequest({
      id: 's1',
      type: 'click',
      description: 'click sk_test_LEAK_VALUE button',
    } as unknown as PreviewIntentStep);

    const file = await close(id);
    expect(file).not.toBeNull();
    const contents = readAll(file!);
    expect(contents).not.toContain('sk_test_LEAK_VALUE');
    expect(contents).toContain('***');
  });

  it('redacts secret values inside step_apply_result.appliedStep', async () => {
    const id = `test_${Date.now()}_b`;
    const map = new Map<string, unknown>([['secrets.K', 'super_long_token_xyz']]);
    const trace = build(id, map);

    trace.writeStepApplyResult({
      success: true,
      appliedStep: {
        id: 's1',
        type: 'type',
        description: 'plain',
        value: 'super_long_token_xyz',
        assertionText: 'expected super_long_token_xyz',
      } as unknown as PreviewIntentStep,
    });

    const file = await close(id);
    const contents = readAll(file!);
    expect(contents).not.toContain('super_long_token_xyz');
    expect(contents).toContain('***');
  });

  it('redacts secret values inside step_apply_result.error', async () => {
    const id = `test_${Date.now()}_c`;
    const map = new Map<string, unknown>([['secrets.K', 'leaked_via_error_msg']]);
    const trace = build(id, map);

    trace.writeStepApplyResult({
      success: false,
      error: 'fill failed for value leaked_via_error_msg on selector #x',
    });

    const file = await close(id);
    const contents = readAll(file!);
    expect(contents).not.toContain('leaked_via_error_msg');
  });

  it('is a no-op when no provider is wired', async () => {
    const id = `test_${Date.now()}_d`;
    const trace = EditorTraceService.getOrCreate(id, 'u');
    // Override the auto-wired provider with a stub that returns undefined
    // so we test the truly-no-redact path deterministically.
    trace.setRunVariablesProvider(() => undefined);
    trace.writeStepApplyRequest({
      id: 's1',
      type: 'click',
      description: 'safe text only',
    } as unknown as PreviewIntentStep);

    const file = await close(id);
    const contents = readAll(file!);
    expect(contents).toContain('safe text only');
  });
});
