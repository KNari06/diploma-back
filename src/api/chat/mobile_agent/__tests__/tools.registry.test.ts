/**
 * Lightweight contract test for the MOBILE_AGENT_TOOLS array. Catches
 * regressions where someone removes a Phase B5 tool definition or
 * forgets to register a new one. Cheap (no I/O) — fast feedback on
 * structural changes.
 */

import { MOBILE_AGENT_TOOLS, MOBILE_ACTION_TOOLS } from '../tools';

describe('MOBILE_AGENT_TOOLS registry', () => {
  it('exposes all Phase B5 observation tools', () => {
    const names = MOBILE_AGENT_TOOLS.map((t) => t.function.name);
    // The observation suite must include the heavy `observe_mobile_page`
    // plus the four cheap probes. Each is referenced by the system
    // prompt (prompts.ts) — adding/removing one without updating the
    // prompt is the kind of drift this test catches.
    expect(names).toEqual(
      expect.arrayContaining([
        'observe_mobile_page',
        'get_foreground',
        'get_step_history',
        'get_recent_logs',
        'take_screenshot',
      ]),
    );
  });

  it('keeps existing action + authoring tools registered', () => {
    const names = MOBILE_AGENT_TOOLS.map((t) => t.function.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'tap_element',
        'type_text',
        'swipe',
        'scroll',
        'press_key',
        'launch_app',
        'plan_flow',
        'mobile_create_test_case',
      ]),
    );
  });

  it('lists cheap observation tools RIGHT AFTER observe_mobile_page (system-prompt order matters)', () => {
    const names = MOBILE_AGENT_TOOLS.map((t) => t.function.name);
    const observeIdx = names.indexOf('observe_mobile_page');
    const getForegroundIdx = names.indexOf('get_foreground');
    const getStepHistoryIdx = names.indexOf('get_step_history');
    const getRecentLogsIdx = names.indexOf('get_recent_logs');
    const takeScreenshotIdx = names.indexOf('take_screenshot');
    expect(observeIdx).toBeGreaterThanOrEqual(0);
    expect(getForegroundIdx).toBe(observeIdx + 1);
    expect(getStepHistoryIdx).toBe(observeIdx + 2);
    expect(getRecentLogsIdx).toBe(observeIdx + 3);
    expect(takeScreenshotIdx).toBe(observeIdx + 4);
  });

  it('MOBILE_ACTION_TOOLS still excludes observation tools (fast-path stays single-step)', () => {
    const names = MOBILE_ACTION_TOOLS.map((t) => t.function.name);
    expect(names).not.toContain('observe_mobile_page');
    expect(names).not.toContain('get_foreground');
    expect(names).not.toContain('get_step_history');
    expect(names).not.toContain('get_recent_logs');
    expect(names).not.toContain('take_screenshot');
  });

  it('every tool has a description (LLM needs guidance to pick correctly)', () => {
    for (const t of MOBILE_AGENT_TOOLS) {
      expect(t.function.description).toBeTruthy();
      expect((t.function.description as string).length).toBeGreaterThan(30);
    }
  });
});
