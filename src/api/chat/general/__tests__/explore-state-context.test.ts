/**
 * Slice B — the agent must SEE the current Explore screen. The frontend
 * sends a facts-only snapshot; formatExploreStateForChat renders it into a
 * system message (plain language, no internal jargon, no secrets). These
 * tests pin that mapping.
 */

import { formatExploreStateForChat } from '../handler';

describe('formatExploreStateForChat', () => {
  it('returns null for missing / non-object state', () => {
    expect(formatExploreStateForChat(undefined)).toBeNull();
    expect(formatExploreStateForChat(null)).toBeNull();
    expect(formatExploreStateForChat('x')).toBeNull();
  });

  it('returns null for the plain web surface (no extra live state yet)', () => {
    expect(formatExploreStateForChat({ surface: 'web' })).toBeNull();
  });

  it('describes a READY mobile screen with platform + app', () => {
    const msg = formatExploreStateForChat({
      surface: 'mobile', platform: 'android', appId: 'kz.kolesa', ready: true,
    });
    expect(msg).toContain('Mobile app exploration');
    expect(msg).toContain('android');
    expect(msg).toContain('kz.kolesa');
    expect(msg).toMatch(/READY/);
  });

  it('maps blocker keys to plain language (no jargon) when NOT ready', () => {
    const msg = formatExploreStateForChat({
      surface: 'mobile', platform: 'android', ready: false, blockers: ['runner', 'llm'],
    });
    expect(msg).toMatch(/NOT READY/);
    expect(msg).toContain('mobile testing service is offline');
    expect(msg).toContain('testing service AI is not configured');
    // Internal jargon must not leak.
    expect(msg).not.toMatch(/\brunner\b/);
    expect(msg).not.toMatch(/LLM/);
    // Guidance for the agent to explain the fix.
    expect(msg).toMatch(/contact support|try again|upload|debug/i);
  });

  it('handles NOT READY with no explicit blockers (preparing)', () => {
    const msg = formatExploreStateForChat({ surface: 'mobile', ready: false, blockers: [] });
    expect(msg).toMatch(/NOT READY/);
  });
});
