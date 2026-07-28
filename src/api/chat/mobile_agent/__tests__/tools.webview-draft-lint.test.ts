/**
 * Guards for the draft-time authoring checks added after the JanaPost TC-30 /
 * TC-31 sessions, where the agent produced tests that demoed perfectly and
 * could never pass.
 *
 * Two of these HARD-REJECT the draft, because they are definitionally broken:
 *   - a `{{param_*}}` placeholder as an entire `assertionText` — nothing
 *     resolves it at replay, so the check can never fail;
 *   - a `web_*` step whose `bindingHints.selector` is prose — `querySelector`
 *     on an element description can never match.
 *
 * `isWebViewHostActivity` drives an ADVISORY only. A native tap on a WebView
 * screen is unreliable, not impossible: the runner's `executeCommand`
 * early-WebView branch resolves the description against the DOM and taps the
 * element's real device pixel. Blocking it would foreclose a supported route,
 * so the draft is accepted with a warning appended to the tool result.
 *
 * The wiring into `runMobileRunDraftSteps` needs a live blackboard + runner, so
 * it is exercised end-to-end in the live sessions; what is unit tested here is
 * the classification these checks turn on, which is where the
 * false-positive/false-negative risk actually lives.
 */

import { isWebViewHostActivity, looksLikeProseNotCssSelector, resolveForegroundActivity, summariseDraftChange } from '../tools';
import type { MobileIntentStep } from '@/services/mobile/mobile-runner.types';

const s = (
  type: string,
  description: string,
  extra: Partial<MobileIntentStep> = {},
): MobileIntentStep =>
  ({ id: 'step_x', type, description, ...extra }) as MobileIntentStep;

describe('isWebViewHostActivity', () => {
  it('recognises the Jaña Post WebView host that broke TC-30 and TC-31', () => {
    // The exact string dumpsys reported while the Tariffs and Education
    // screens were foregrounded.
    expect(isWebViewHostActivity('com.eq.jana_webview.view.WebViewActivity')).toBe(true);
  });

  it('recognises the common cross-framework WebView hosts', () => {
    const hosts = [
      'com.example.app.WebViewActivity',
      'org.apache.cordova.CordovaActivity',
      'com.getcapacitor.BridgeActivity',
      'com.example/.InAppBrowserActivity',
      'com.vendor.webview.WebviewActivity', // lowercase 'v'
      'com.vendor.ui.Web_ViewActivity',
    ];
    for (const h of hosts) {
      expect([h, isWebViewHostActivity(h)]).toEqual([h, true]);
    }
  });

  it('does NOT flag ordinary native activities', () => {
    // A false positive blocks a legitimate native step, so this is the
    // direction that must never drift. Note the near-misses: an activity may
    // mention "web" without being a WebView host.
    const natives = [
      'com.aitan.inexport.MainActivity',
      'io.flutter.embedding.android.FlutterActivity',
      'com.google.android.apps.nexuslauncher/.NexusLauncherActivity',
      'com.example.WebsiteListActivity',
      'com.example.WebhookSettingsActivity',
      'com.example.SpiderwebActivity',
      'com.example.ActivityWebView', // "Activity" not in trailing position
    ];
    for (const a of natives) {
      expect([a, isWebViewHostActivity(a)]).toEqual([a, false]);
    }
  });

  it('treats missing / blank activity as native (iOS reports no activity)', () => {
    // The runner's IosSession surfaces `activity: undefined`. Defaulting to
    // "not a WebView" keeps the lint from firing on every iOS draft.
    expect(isWebViewHostActivity(undefined)).toBe(false);
    expect(isWebViewHostActivity(null)).toBe(false);
    expect(isWebViewHostActivity('')).toBe(false);
    expect(isWebViewHostActivity('   ')).toBe(false);
  });
});

describe('placeholder-as-assertion detection', () => {
  // Mirrors the guard's regex in runMobileRunDraftSteps. Kept as a test over
  // the same pattern so the intent — whole-string `param_` only — is pinned.
  const isPlaceholderAssertion = (s: string) => /^\{\{param_[a-zA-Z0-9_]+\}\}$/.test(s.trim());

  it('rejects the exact value that destroyed the TC-31 marketplace assertion', () => {
    expect(isPlaceholderAssertion('{{param_secret}}')).toBe(true);
    expect(isPlaceholderAssertion('  {{param_secret}}  ')).toBe(true);
    expect(isPlaceholderAssertion('{{param_password}}')).toBe(true);
  });

  it('leaves bound-secret placeholders embedded in real text alone', () => {
    // `Welcome back, {{secrets.login_email}}` is a legitimate assertion — the
    // credential path templates it deliberately and it resolves at replay.
    // Re-parameterising or rejecting it would false-RED every login test.
    expect(isPlaceholderAssertion('Welcome back, {{secrets.login_email}}')).toBe(false);
    expect(isPlaceholderAssertion('{{secrets.login_email}}')).toBe(false);
    expect(isPlaceholderAssertion('{{env.base_url}}')).toBe(false);
    expect(isPlaceholderAssertion('{{extracted.order_id}}')).toBe(false);
  });

  it('leaves a param placeholder embedded in surrounding prose alone', () => {
    // Only a WHOLE-string placeholder is meaningless. Text around it means the
    // author wrote a real expectation.
    expect(isPlaceholderAssertion('The total is {{param_amount}} tenge')).toBe(false);
  });

  it('leaves real assertions alone', () => {
    expect(
      isPlaceholderAssertion(
        'The marketplace list shows SHEIN with 4 Lessons, Pinduoduo with 6 Lessons and 10 Лайфхактар',
      ),
    ).toBe(false);
  });
});

describe('summariseDraftChange', () => {
  it('says nothing for a first draft (no previous to compare against)', () => {
    expect(summariseDraftChange(undefined, [s('tap', 'Profile tab')])).toBe('');
    expect(summariseDraftChange([], [s('tap', 'Profile tab')])).toBe('');
  });

  it('reports a silently dropped step — the TC-30 failure mode', () => {
    // The agent re-emitted a draft without the `Tap Tariffs row` navigation
    // step, so the next step acted on a screen that was never opened, and the
    // reply mentioned only the assertion it meant to change.
    const before = [
      s('tap', 'Profile tab'),
      s('tap', 'Tariffs row'),
      s('ai_check', 'city chips', { assertionText: 'Алматы, Астана, Шымкент' }),
    ];
    const after = [
      s('tap', 'Profile tab'),
      s('ai_check', 'city chips', { assertionText: 'Алматы, Астана, Шымкент' }),
    ];
    const out = summariseDraftChange(before, after);
    expect(out).toContain('1 removed/changed');
    expect(out).toContain('2 unchanged');
    expect(out).toContain('re-emit the draft');
  });

  it('reports a wholesale rewrite that claimed to keep steps unchanged', () => {
    // TC-31: the reply said "steps 1,2,3,5,6,7 were kept as-is" while every
    // step differed. The summary contradicts that claim in one line.
    const before = [s('tap', 'Lessons row in Profile'), s('ai_check', 'main video')];
    const after = [s('tap', 'Education tab on the Profile screen'), s('ai_check', 'main lesson card')];
    const out = summariseDraftChange(before, after);
    expect(out).toContain('2 added/changed');
    expect(out).toContain('2 removed/changed');
    expect(out).toContain('(0 unchanged)');
  });

  it('flags an identical re-emission, so a no-op revision is visible too', () => {
    const draft = [s('tap', 'Profile tab'), s('ai_check', 'video', { assertionText: 'X' })];
    expect(summariseDraftChange(draft, [...draft])).toBe(' (identical to the previous draft)');
  });

  it('counts a changed assertion as one changed step, not two', () => {
    const before = [s('tap', 'Pinduoduo card'), s('ai_check', 'detail', { assertionText: 'old' })];
    const after = [s('tap', 'Pinduoduo card'), s('ai_check', 'detail', { assertionText: 'new' })];
    const out = summariseDraftChange(before, after);
    expect(out).toContain('1 added/changed');
    expect(out).toContain('1 removed/changed');
    expect(out).toContain('(1 unchanged)');
  });

  it('does not report a pure reorder as a change', () => {
    // Moving a step is not losing one; positional diffing would cry wolf here
    // and train people to ignore the line.
    const a = s('tap', 'A');
    const b = s('ai_check', 'B', { assertionText: 'b' });
    expect(summariseDraftChange([a, b], [b, a])).toBe(' (identical to the previous draft)');
  });

  it('ignores renumbered ids — the model reuses positional ids across drafts', () => {
    const before = [{ ...s('tap', 'Profile tab'), id: 'step_1' } as MobileIntentStep];
    const after = [{ ...s('tap', 'Profile tab'), id: 'step_4' } as MobileIntentStep];
    expect(summariseDraftChange(before, after)).toBe(' (identical to the previous draft)');
  });

  it('reports a pure addition without the restore nudge', () => {
    const before = [s('tap', 'Profile tab')];
    const after = [s('tap', 'Profile tab'), s('ai_check', 'video', { assertionText: 'X' })];
    const out = summariseDraftChange(before, after);
    expect(out).toContain('1 added/changed');
    expect(out).not.toContain('removed');
    expect(out).not.toContain('re-emit the draft');
  });
});

describe('resolveForegroundActivity', () => {
  it('falls back to actualForeground when the legacy field is absent', () => {
    // The exact shape GET /api/sessions/:id/ui-state returned on a live Flutter
    // session: no top-level `activity` at all, truth only in actualForeground.
    // Reading `activity` alone meant the WebView lint could never fire on the
    // very app class it exists for.
    const snap = {
      actualForeground: {
        primary: {
          packageName: 'com.aitan.inexport',
          activityName: 'com.aitan.inexport/com.eq.jana_webview.view.WebViewActivity',
        },
      },
    };
    expect(resolveForegroundActivity(snap)).toBe(
      'com.aitan.inexport/com.eq.jana_webview.view.WebViewActivity',
    );
    expect(isWebViewHostActivity(resolveForegroundActivity(snap))).toBe(true);
  });

  it('prefers the legacy field when both are present', () => {
    expect(
      resolveForegroundActivity({
        activity: 'com.example.MainActivity',
        actualForeground: { primary: { activityName: 'com.example.OtherActivity' } },
      }),
    ).toBe('com.example.MainActivity');
  });

  it('returns undefined when neither is usable', () => {
    expect(resolveForegroundActivity(undefined)).toBeUndefined();
    expect(resolveForegroundActivity(null)).toBeUndefined();
    expect(resolveForegroundActivity({})).toBeUndefined();
    expect(resolveForegroundActivity({ activity: '  ' })).toBeUndefined();
    expect(resolveForegroundActivity({ actualForeground: { primary: null } })).toBeUndefined();
    expect(
      resolveForegroundActivity({ actualForeground: { primary: { activityName: null } } }),
    ).toBeUndefined();
  });

  it('recognises the package/activity form dumpsys returns', () => {
    // Note the '/' separator — the regex must anchor across it, not only on '.'
    expect(
      isWebViewHostActivity('com.aitan.inexport/com.eq.jana_webview.view.WebViewActivity'),
    ).toBe(true);
    expect(isWebViewHostActivity('com.example.app/.MainActivity')).toBe(false);
  });
});

describe('looksLikeProseNotCssSelector', () => {
  it('flags the exact prose that made TC-31 step 6 fail at replay', () => {
    // The agent authored a correct `web_click` but put an a11y description in
    // bindingHints.selector. CDP ran querySelector on it → "element not found".
    expect(looksLikeProseNotCssSelector('Pinduoduo marketplace card')).toBe(true);
    expect(looksLikeProseNotCssSelector('the TaoBao card in the list')).toBe(true);
    expect(looksLikeProseNotCssSelector('Login button at the top right')).toBe(true);
  });

  it('accepts real CSS selectors', () => {
    for (const s of [
      'a[href*="pinduoduo"]',
      '.marketplace-card:nth-of-type(2)',
      '#lesson-list li',
      'button#login-btn',
      'input[name="email"]',
      '.card > .title',
      'div.a span.b',
      '[data-testid="pinduoduo"]',
      'section:has(> h2)',
    ]) {
      expect([s, looksLikeProseNotCssSelector(s)]).toEqual([s, false]);
    }
  });

  it('accepts a bare tag or class with no whitespace', () => {
    expect(looksLikeProseNotCssSelector('button')).toBe(false);
    expect(looksLikeProseNotCssSelector('Pinduoduo')).toBe(false);
  });

  it('accepts a whitespace-only descendant combinator of real tag names', () => {
    // `div span` is a legitimate selector — must NOT be flagged, or the lint
    // would block valid authoring.
    expect(looksLikeProseNotCssSelector('div span')).toBe(false);
    expect(looksLikeProseNotCssSelector('ul li a')).toBe(false);
  });

  it('ignores empty / whitespace input (handled by the missing-selector branch)', () => {
    expect(looksLikeProseNotCssSelector('')).toBe(false);
    expect(looksLikeProseNotCssSelector('   ')).toBe(false);
  });
});
