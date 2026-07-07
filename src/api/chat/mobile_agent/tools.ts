/**
 * Mobile-agent tool surface (Phase 4).
 *
 * Tools exposed to the LLM:
 *   - observe_mobile_page      — read current screen (Phase 3, read-only)
 *   - tap_element              — tap by intent description (Phase 4)
 *   - type_text                — type into a focused field (Phase 4)
 *   - swipe                    — directional swipe (Phase 4)
 *   - scroll                   — scroll the screen (Phase 4)
 *   - press_key                — back / home / enter (Phase 4)
 *   - launch_app               — start app by package / bundle id (Phase 4)
 *
 * Design choices:
 *   1. ALL actions are expressed by `intent` (human-readable target description).
 *      The runner's smartResolve pipeline turns that into coordinates via
 *      LLM + vision. The backend never ships raw coords — the LLM shouldn't
 *      be guessing pixel positions anyway.
 *   2. Every mutating tool invalidates the blackboard snapshot cache so a
 *      follow-up observe_mobile_page returns the POST-action screen.
 *   3. Every tool result is a ToolResult object with a human-readable
 *      `content` string — this goes verbatim into the LLM's `tool` message.
 *      We also attach the raw runner CommandResult to `data` for callers
 *      that want structured access.
 *   4. Interactive timeout on the runner is 8s — we use noRetry for tool
 *      calls because a silent retry of a "tap" could cause double-click bugs.
 */

import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { getMobileRunnerClientForSession } from '@/services/mobile/session-runner-routing';
import { redactPii } from '@/services/chat/pii-redactor';
import { wrapUntrusted } from '@/services/chat/untrusted-content-wrapper';
import { env } from '@/config/environment/env';
import { incCounter, observeMs } from '@/utils/core/mobile-chat-metrics';
import {
  MobileRunnerError,
  frameworkToMobilePlatformKey,
  type MobileIntentStep,
  type MobilePlatform,
} from '@/services/mobile/mobile-runner.types';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import {
  getAccessibleProject,
  listMobileProjectOptions,
} from '@/services/chat/mobile-project-context.service';
import { logger } from '@/utils/core/logger';
import type { MobileBlackboard } from './blackboard';
import { generateFlowPlan, type ConcreteFlowPlan } from './planner';
import { MobileDraftStepsCache } from '@/services/testing/mobile/mobile-draft-steps-cache';
import { RegressionSaveService } from '@/services/testing/regression/regression-save.service';
import {
  emitMobileAgentThinking,
  emitMobilePlanningStep,
  mobileToolProgress,
} from './progress';
import {
  sanitizeReasoning,
  safeTruncate,
  WS_PREVIEW_CHARS,
  TRACE_PER_ENTRY,
} from './reasoning-trace';

// ═══════════════════════════════════════════════════════════════════════════
// TOOL SCHEMAS — what the LLM sees. Keep descriptions tight and imperative.
// ═══════════════════════════════════════════════════════════════════════════

export const OBSERVE_MOBILE_PAGE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'observe_mobile_page',
    description:
      'Read the current mobile screen. Returns the accessibility tree as ' +
      'a compact ASCII dump, current app/activity, screen size, and keyboard/dialog ' +
      'flags. Also returns device-fresh foreground truth: `expectedApp` (what we ' +
      'launched), `actualForeground` (what is ON SCREEN right now via dumpsys — ' +
      'screenState + window stack + primary window), `foregroundMismatch` (set when ' +
      'expected ≠ actual — warn the user the app under test is no longer focused), ' +
      '`recentDisruption` (crash / ANR observed since the last call — surface it ' +
      'rather than acting on a broken UI), and `webView` (detected + suggestedContext ' +
      '— call switch_to_webview when suggestedContext is "webview"). Call this BEFORE ' +
      'acting or answering anything about the UI, and AGAIN after any action to see ' +
      'the post-action state. Safe to call multiple times — read-only.',
    parameters: {
      type: 'object',
      properties: {
        forceRefresh: {
          type: 'boolean',
          description:
            'Bypass the per-turn cache and grab a fresh snapshot. Default false.',
        },
      },
      additionalProperties: false,
    },
  },
};

const TAP_ELEMENT_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'tap_element',
    description:
      'Tap a single element on the screen. Describe the target by its visible text, ' +
      'accessibility id, resource id, or role (e.g. "Login button", "email input", ' +
      '"Skip link in top-right"). The runner resolves the description to coordinates. ' +
      'Never pass raw x/y — describe what a human would see.',
    parameters: {
      type: 'object',
      properties: {
        targetDescription: {
          type: 'string',
          description:
            'Human-readable target: visible text, resId, accessibility-id, or role + location. ' +
            'Be specific — "Login button" beats "the button".',
        },
        longPress: {
          type: 'boolean',
          description: 'Hold the tap for ~1 second (long-press). Default false.',
        },
      },
      required: ['targetDescription'],
      additionalProperties: false,
    },
  },
};

const TYPE_TEXT_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'type_text',
    description:
      'Type text into a field. Focuses the field first (taps it) then types. ' +
      'If `isSensitive` is true, the runner masks the value in logs. For passwords, ' +
      'OTPs, and API keys — always set isSensitive=true.',
    parameters: {
      type: 'object',
      properties: {
        targetDescription: {
          type: 'string',
          description: 'The input field to type into, e.g. "email input", "search box".',
        },
        text: {
          type: 'string',
          description: 'Text to type. Exactly as the user wants it entered.',
        },
        clearFirst: {
          type: 'boolean',
          description: 'Clear the field before typing. Default true.',
        },
        isSensitive: {
          type: 'boolean',
          description:
            'True for passwords / OTPs / tokens. Masks value in logs. Default false.',
        },
      },
      required: ['targetDescription', 'text'],
      additionalProperties: false,
    },
  },
};

const SWIPE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'swipe',
    description:
      'Directional swipe across the screen — for dismissing dialogs, revealing ' +
      'elements, or navigating carousels. For scrolling within a list, prefer `scroll`.',
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Direction of the swipe.',
        },
      },
      required: ['direction'],
      additionalProperties: false,
    },
  },
};

const SCROLL_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'scroll',
    description:
      'Scroll the screen (or a specific scrollable container) in a direction. ' +
      'Use this to bring offscreen elements into view before tapping them.',
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Scroll direction.',
        },
        containerDescription: {
          type: 'string',
          description:
            'Optional: scroll inside a specific list / view (e.g. "product list"). ' +
            'If omitted, scroll the whole screen.',
        },
      },
      required: ['direction'],
      additionalProperties: false,
    },
  },
};

const PRESS_KEY_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'press_key',
    description:
      'Press a hardware / system key. Use `back` to dismiss, `home` to minimize the ' +
      'app, `enter` to submit a focused field.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          // Deliberately narrow enum: only keys with known-good runner
          // support across Android/iOS are exposed. `back` + `home` route
          // to dedicated runner commands (go_back/go_home); `enter` goes
          // through the generic press_key path. Adding more keys here
          // requires verifying both iOS (WDA) and Android (ADB) accept
          // the keycode — otherwise the LLM gets a silent "unknown
          // failure" from the runner.
          enum: ['back', 'home', 'enter'],
          description: 'Logical key name.',
        },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
};

const LAUNCH_APP_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'launch_app',
    description:
      'Launch an app by package name (Android) or bundle id (iOS). Use this to ' +
      'switch apps or restart the app under test when it gets stuck. Use the EXACT ' +
      'package / bundle id from the current session\u2019s `app` field if you need ' +
      'to re-launch the app under test.',
    parameters: {
      type: 'object',
      properties: {
        packageName: {
          type: 'string',
          description: 'Android package name (com.example.app) or iOS bundle id.',
        },
        clearData: {
          type: 'boolean',
          description:
            'Clear app data before launching (fresh install state). Default false.',
        },
      },
      required: ['packageName'],
      additionalProperties: false,
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────
// WebView tools (Phase 8). For hybrid apps (Capacitor / Cordova / Ionic /
// React-Native WebView / Flutter InAppWebView) and native apps that
// embed an OAuth or payment WebView. The runner already has full CDP
// (Android) and WDA-WebView (iOS) executors; these tools surface that
// power to the LLM.
//
// Workflow:
//   1. switch_to_webview — runner connects CDP / WDA-WebView, future
//      observe / tap / type calls target the DOM, not the native a11y
//      tree. List candidates first via list_webview_contexts when more
//      than one WebView is on screen.
//   2. tap_element / type_text continue to work the same way — the runner
//      auto-routes to dispatchWeb() once the session is in WEB context.
//   3. switch_to_native — return to UIAutomator / WDA when done with the
//      web flow. The action tools route back to native automatically.
//   4. web_evaluate — escape hatch for assertions ("page contains 'Welcome'")
//      or for grabbing a hidden form value.
//
// Requires Android apps to be DEBUG-built (or compiled with
// `setWebContentsDebuggingEnabled(true)`); iOS Simulator works as-is.
// Production-signed Android APKs cannot expose the CDP socket and the
// runner pre-flight check returns a clear error in that case.
// ─────────────────────────────────────────────────────────────────────────

const LIST_WEBVIEW_CONTEXTS_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'list_webview_contexts',
    description:
      'List the WebView contexts currently visible on the device. Returns ' +
      'each context’s id, url, title, and (best-effort) framework hint ' +
      '(capacitor / cordova / ionic / rn-webview / flutter-iaw / unknown). ' +
      'Call before `switch_to_webview` when the screen has more than one ' +
      'WebView (e.g. parent app + embedded payment iframe). Read-only.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
};

const SWITCH_TO_WEBVIEW_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'switch_to_webview',
    description:
      'Switch the session into WebView (DOM) context. After this, ' +
      '`observe_mobile_page` returns the HTML tree and `tap_element` / ' +
      '`type_text` operate on DOM elements. Always pair with ' +
      '`switch_to_native` once the web flow is done so subsequent native ' +
      'taps work. On Android the app must be a debug build (' +
      '`setWebContentsDebuggingEnabled(true)`); production APKs return an ' +
      'error.',
    parameters: {
      type: 'object',
      properties: {
        contextId: {
          type: 'string',
          description:
            'Optional. The id from `list_webview_contexts`. Omit to let the ' +
            'runner pick the most-likely-foreground WebView. Useful when ' +
            'multiple WebViews are visible.',
        },
      },
      additionalProperties: false,
    },
  },
};

const SWITCH_TO_NATIVE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'switch_to_native',
    description:
      'Switch the session back to the native a11y tree (UIAutomator / WDA). ' +
      'Idempotent — safe to call when already in native context. Always ' +
      'call after a WebView flow before returning control to the user, so ' +
      'the next message defaults to the native screen the user expects.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
};

const WEB_EVALUATE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'web_evaluate',
    description:
      'Run a JavaScript expression in the active WebView and return the ' +
      'result (must be JSON-serialisable). Use for assertions ("does ' +
      'document.title contain X?") and for reading hidden form values. ' +
      'NEVER use to type passwords or other secrets — those go through ' +
      '`type_text` with isSensitive=true. Requires switch_to_webview first.',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          minLength: 1,
          maxLength: 1000,
          description:
            'A JavaScript expression. Examples: "document.title", ' +
            '"document.querySelectorAll(\'.error\').length", ' +
            '"!!document.querySelector(\'#welcome-banner\')".',
        },
      },
      required: ['expression'],
      additionalProperties: false,
    },
  },
};

// Planning tools (Phase 5). `plan_flow` produces a FlowPlan and stores it
// in the blackboard. `start_plan_step` / `finish_plan_step` let the LLM
// walk the plan explicitly — the executor knows what's in progress, what
// succeeded, what failed, and can re-plan if things drift.
//
// The LLM decides when to plan. For simple queries ("what's on the
// screen?") it never calls plan_flow. For multi-step flows ("create a
// login test", "log in and go to profile") the executor sees from the
// system prompt that planning is its first move.
// ─────────────────────────────────────────────────────────────────────────

const PLAN_FLOW_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'plan_flow',
    description:
      'Decompose a multi-step user goal into an ordered checklist of sub-goals. ' +
      'Call this ONCE at the start of any flow that needs more than one action ' +
      '(login, checkout, registration, multi-field form fill, exploration of a ' +
      'specific feature). Do NOT call for single-action requests like "tap X". ' +
      'After planning, walk the plan via start_plan_step / finish_plan_step. ' +
      'If the goal is too vague to plan (no target flow / no success criteria), ' +
      'this returns a clarifying question instead of a plan — relay it to the ' +
      'user and STOP; do not author or run steps until they answer.',
    parameters: {
      type: 'object',
      properties: {
        userGoal: {
          type: 'string',
          description:
            'The user request restated concisely — "Create a login test using ' +
            'admin / provided password", "Sign up and add item to cart".',
        },
      },
      required: ['userGoal'],
      additionalProperties: false,
    },
  },
};

const START_PLAN_STEP_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'start_plan_step',
    description:
      'Mark a plan step as in_progress and retrieve its details (intent + verify ' +
      'criteria). Call before executing the action(s) for that step.',
    parameters: {
      type: 'object',
      properties: {
        stepId: {
          type: 'number',
          description: 'ID of the step from the current plan.',
        },
      },
      required: ['stepId'],
      additionalProperties: false,
    },
  },
};

const THINK_ALOUD_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'think_aloud',
    description:
      'Share a brief thought with the user about what you\'re about to do or why. ' +
      'Read-only — does NOT touch the device. Use this to make your reasoning visible ' +
      'in the chat indicator BEFORE acting on something non-obvious. Examples: ' +
      '"Looking for the email field — it\'s usually at the top of login screens", ' +
      '"The submit button looks disabled, I\'ll fill the password first". ' +
      'Keep it short (one or two sentences). Do NOT use for trivial steps; the ' +
      'user already sees the tool name. Do NOT include passwords, tokens, or other ' +
      'sensitive values — credentials are masked but it\'s safer to refer to them ' +
      'abstractly ("the password the user provided").',
    parameters: {
      type: 'object',
      properties: {
        thought: {
          type: 'string',
          minLength: 5,
          maxLength: 1000,
          description: 'Your thought, in plain English (or the user\'s language). 1-2 sentences.',
        },
      },
      required: ['thought'],
      additionalProperties: false,
    },
  },
};

const FINISH_PLAN_STEP_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'finish_plan_step',
    description:
      'Mark the current step as done, failed, or skipped. ALWAYS call this after ' +
      'attempting a step so the plan state stays accurate. If `status=failed`, ' +
      'include `reason`; you may retry the step (call start_plan_step again) ' +
      'up to 2 times total before moving on.',
    parameters: {
      type: 'object',
      properties: {
        stepId: {
          type: 'number',
          description: 'ID of the step being closed out.',
        },
        status: {
          type: 'string',
          enum: ['done', 'failed', 'skipped'],
        },
        reason: {
          type: 'string',
          description: 'Short explanation when status is failed or skipped.',
        },
      },
      required: ['stepId', 'status'],
      additionalProperties: false,
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Authoring tools (Phase 6) — generate / run / save reusable test cases.
// Mirror of qa_run_draft_steps + qa_create_test_case on the web side.
// The LLM produces MobileIntentStep[] directly as tool input — no implicit
// recording of action calls. This keeps the authoring contract explicit:
// what the LLM ships is what gets persisted.
// ─────────────────────────────────────────────────────────────────────────

const MOBILE_RUN_DRAFT_STEPS_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'mobile_run_draft_steps',
    description:
      'Execute a list of mobile test steps as a draft on the live device, ' +
      'and cache them for the chat session so the user can save them later. ' +
      'Use this when the user asks you to "run" / "execute" / "try out" a ' +
      'flow you just designed. Steps are NOT persisted yet — call ' +
      'mobile_create_test_case afterward if the user asks to save.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          description:
            'Ordered list of MobileIntentStep objects. Each must have id, type, ' +
            'description. Use placeholders like "{{param_password}}" for any ' +
            'sensitive value rather than the real string — the runner substitutes ' +
            'at replay time.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: {
                type: 'string',
                description:
                  'Mobile action type. Common values: "click" (tap), "type" ' +
                  '(text input), "swipe", "scroll", "press" (hardware key), ' +
                  '"open_app", "close_app", "go_back", "go_home", "long_press", ' +
                  '"double_tap", "assert", "ai_check", "wait_for". ' +
                  'System-flow values: "dismiss" (close top modal/sheet/alert — ' +
                  'use this for cookie banners, "rate us" prompts, system ' +
                  'dialogs), "biometric" (Face ID / Touch ID / fingerprint — ' +
                  'set options.biometricAction to "match"/"fail"), "otp" ' +
                  '(SMS code / TOTP — set options.otpAction to "read_sms"/' +
                  '"generate_totp"/"type_otp"), "permission" (Android/iOS ' +
                  'permission prompt — set options.permissionAction to ' +
                  '"allow"/"deny"/"allow_always"). Runner aliases ("tap", ' +
                  '"input_text", "press_key", "launch_app") also work.',
              },
              description: {
                type: 'string',
                description:
                  'Human-readable target description (visible text / resId / ' +
                  'accessibility-id). The runner resolves it to coordinates.',
              },
              value: {
                type: 'string',
                description:
                  'Value for input steps. Use {{param_<name>}} placeholder for ' +
                  'passwords, OTPs, tokens — never the literal secret.',
              },
              assertionText: {
                type: 'string',
                description:
                  'Natural-language assertion for assert_visible / assert_text steps.',
              },
              isSensitive: {
                type: 'boolean',
                description:
                  'Set true when `value` is a credential (password, OTP, ' +
                  'token, API key, PIN). On save the value is replaced by a ' +
                  '{{param_*}} placeholder regardless of wording — this flag ' +
                  'is the authoritative signal, mirroring type_text\'s ' +
                  'isSensitive. Default false.',
              },
            },
            required: ['id', 'type', 'description'],
            additionalProperties: true,
          },
        },
        suggestedName: {
          type: 'string',
          description:
            '3-5 word title to default the saved test case to (e.g. ' +
            '"Login with Email", "Add to Cart"). Optional but helpful.',
        },
        confirm: {
          type: 'boolean',
          description:
            'Must be true to actually run. Pass false to merely cache the draft ' +
            'without execution (rare — use only when the user wants to review ' +
            'before running).',
        },
      },
      required: ['steps', 'confirm'],
      additionalProperties: false,
    },
  },
};

const MOBILE_CREATE_TEST_CASE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'mobile_create_test_case',
    description:
      'Persist the most recently cached draft (from mobile_run_draft_steps) ' +
      'as a reusable test case the user can replay later via "run saved <name>". ' +
      'Call ONLY when the user explicitly asks to save / persist / store. ' +
      'Steps are sanitised: any value tagged with credential-like context ' +
      '(password, token, secret, etc.) is replaced by a parameter placeholder.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'User-visible test case name. Falls back to the cached suggestedName ' +
            'or an auto-generated label if absent.',
        },
        description: {
          type: 'string',
          description: 'Optional longer description.',
        },
        platform: {
          type: 'string',
          enum: ['mobile_android', 'mobile_ios', 'mobile_flutter'],
          description:
            'Override the auto-detected platform. The runner reports Flutter / ' +
            'React-Native sessions as their host (android/ios), so if the user ' +
            'is testing a Flutter app pass "mobile_flutter" explicitly. Omit ' +
            'for native Android / iOS — the cached draft platform is correct.',
        },
        projectId: {
          type: 'string',
          description:
            'Target project id. Omit normally — the chat is already scoped to ' +
            'a project. Pass ONLY when a previous save failed with "could not ' +
            'resolve a project" and the user has since picked one from ' +
            'list_project_options.',
        },
        confirm: {
          type: 'boolean',
          description:
            'Must be true. Defensive against accidental persistence — user must ' +
            'have asked to save.',
        },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
  },
};

const LIST_PROJECT_OPTIONS_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'list_project_options',
    description:
      'List the projects in the user’s workspace a mobile test case could be ' +
      'saved into (id, name, whether a mobile app is uploaded). Call ONLY when ' +
      'mobile_create_test_case failed because no project could be resolved — ' +
      'show the options to the user, ask which one to use, then retry ' +
      'mobile_create_test_case with the chosen projectId. Read-only.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Phase B5 — cheap observation tools (foreground / step-history / logs /
// take_screenshot).
//
// Mental model for the LLM: prefer the SPECIFIC tool over `observe_mobile_page`
// when the question is narrow. observe_mobile_page is the heavy hammer
// (a11y dump + screencap, ~300-800ms, big payload). Each of these is
// ~50-200ms and one-purpose. The system prompt steers selection — these
// descriptions repeat the cost framing so the model has it in context.
// ═══════════════════════════════════════════════════════════════════════════

const GET_FOREGROUND_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'get_foreground',
    description:
      'Cheap probe: returns which app/activity is currently in the foreground via dumpsys (Android) ' +
      'or WDA activeAppInfo (iOS). Does NOT include the a11y tree or a screenshot — much faster than ' +
      'observe_mobile_page (~50-150ms vs ~300-800ms). Use this when the question is purely about ' +
      'identity ("what app is open?", "did the launch land?", "are we still in kz.kolesa?"). Also ' +
      'returns `mismatch` when the session expected one app but dumpsys reports another — surface ' +
      'that to the user before describing UI. Falls back to observe_mobile_page if you need any ' +
      'screen content.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
};

const GET_STEP_HISTORY_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'get_step_history',
    description:
      'Returns the most recent test-step records executed by the runner this session: command type, ' +
      'params summary, success/failure, durationMs, error message. Does NOT touch the device — pulls ' +
      'from in-memory state, ~1ms. Use this for "what did we just do?", "did that tap succeed?", ' +
      'or "show me the last few steps". Sensitive fields (e.g. type_text values) are redacted to ' +
      '{ inputLength, inputClass } by default — never receive raw user-typed text from this tool.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description:
            'How many of the most-recent steps to return. Clamped to [1, 50] server-side. ' +
            'Default 10 — enough context without flooding the prompt.',
          minimum: 1,
          maximum: 50,
        },
      },
      additionalProperties: false,
    },
  },
};

const GET_RECENT_LOGS_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'get_recent_logs',
    description:
      'Returns the recent device log tail (Android logcat or iOS unified log) filtered by severity. ' +
      'Server caps the payload to ~2KB so single calls never blow the prompt budget. Use when the ' +
      'user reports a crash / ANR / unexpected behaviour, or when you observed a tree that hints at ' +
      'a backend error (loading spinner stuck, error toast text). PII (email, phone, card, OTP, JWT) ' +
      'is redacted client-side before injection.',
    parameters: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['verbose', 'debug', 'info', 'warn', 'error'],
          description:
            'Minimum severity to include. Default `warn` — info+ is rarely useful in chat. Pick `error` ' +
            'for crash investigation, `warn` for general health checks.',
        },
        limit: {
          type: 'number',
          description: 'Max log lines (after server-side filter). Clamped to [1, 500] server-side. Default 100.',
          minimum: 1,
          maximum: 500,
        },
      },
      additionalProperties: false,
    },
  },
};

const TAKE_SCREENSHOT_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'take_screenshot',
    description:
      'Capture a fresh PNG of the device screen. EXPENSIVE — ~1500-3000 vision tokens per call. Use ONLY ' +
      'when the text a11y tree is insufficient: icon-only UI, custom-drawn graphics, visual confirmation ' +
      'after a destructive step, or when the user explicitly asks to "see" the screen. The image is ' +
      'returned as a base64 data URL in the tool result so vision-capable models can attach it. Limit ' +
      'of 2 calls per turn — beyond that the tool short-circuits with a budget-exhausted error.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
};

export const MOBILE_AGENT_TOOLS: ChatCompletionTool[] = [
  OBSERVE_MOBILE_PAGE_TOOL,
  // Phase B5 cheap observation tools — listed RIGHT AFTER observe so
  // the LLM sees them as "lighter alternatives" to the heavy probe.
  GET_FOREGROUND_TOOL,
  GET_STEP_HISTORY_TOOL,
  GET_RECENT_LOGS_TOOL,
  TAKE_SCREENSHOT_TOOL,
  TAP_ELEMENT_TOOL,
  TYPE_TEXT_TOOL,
  SWIPE_TOOL,
  SCROLL_TOOL,
  PRESS_KEY_TOOL,
  LAUNCH_APP_TOOL,
  PLAN_FLOW_TOOL,
  START_PLAN_STEP_TOOL,
  FINISH_PLAN_STEP_TOOL,
  THINK_ALOUD_TOOL,
  MOBILE_RUN_DRAFT_STEPS_TOOL,
  MOBILE_CREATE_TEST_CASE_TOOL,
  LIST_PROJECT_OPTIONS_TOOL,
  // WebView (Phase 8) — only relevant for hybrid apps; native flows
  // never call them. Listing them at the bottom keeps the prompt cache
  // stable for native-only sessions while still giving the LLM access
  // when an `android.webkit.WebView` / `WKWebView` is on the screen.
  LIST_WEBVIEW_CONTEXTS_TOOL,
  SWITCH_TO_WEBVIEW_TOOL,
  SWITCH_TO_NATIVE_TOOL,
  WEB_EVALUATE_TOOL,
];

/**
 * Subset of tools the `mobile_action` fast-path exposes — single-step
 * actions only. Excludes observe (we do it once inside the handler) and
 * launch_app (authoring territory).
 */
export const MOBILE_ACTION_TOOLS: ChatCompletionTool[] = [
  TAP_ELEMENT_TOOL,
  TYPE_TEXT_TOOL,
  SWIPE_TOOL,
  SCROLL_TOOL,
  PRESS_KEY_TOOL,
];

// ═══════════════════════════════════════════════════════════════════════════
// TOOL RESULTS
// ═══════════════════════════════════════════════════════════════════════════

export interface ToolResult {
  ok: boolean;
  /** Human-readable body. Goes verbatim into the `tool` role message. */
  content: string;
  /** Optional structured payload for downstream tools that inspect it. */
  data?: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════
// DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════

export async function executeTool(
  name: string,
  rawArgs: string | Record<string, unknown>,
  bb: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const args = parseArgs(rawArgs);
  const startedAt = Date.now();

  // Inner function so we can wrap the switch result with metrics
  // without duplicating the try/catch shape. Returns the raw ToolResult
  // OR throws — both paths are recorded by the wrapper below.
  const runOne = async (): Promise<ToolResult> => {
    switch (name) {
      case 'observe_mobile_page':
        return await runObserveMobilePage(args, bb, opts);
      // Phase B5 — cheap observation tools.
      case 'get_foreground':
        return await runGetForeground(args, bb, opts);
      case 'get_step_history':
        return await runGetStepHistory(args, bb, opts);
      case 'get_recent_logs':
        return await runGetRecentLogs(args, bb, opts);
      case 'take_screenshot':
        return await runTakeScreenshot(args, bb, opts);
      case 'tap_element':
        return await runTapElement(args, bb, opts);
      case 'type_text':
        return await runTypeText(args, bb, opts);
      case 'swipe':
        return await runSwipe(args, bb, opts);
      case 'scroll':
        return await runScroll(args, bb, opts);
      case 'press_key':
        return await runPressKey(args, bb, opts);
      case 'launch_app':
        return await runLaunchApp(args, bb, opts);
      case 'plan_flow':
        return await runPlanFlow(args, bb, opts);
      case 'start_plan_step':
        return runStartPlanStep(args, bb);
      case 'finish_plan_step':
        return runFinishPlanStep(args, bb);
      case 'think_aloud':
        return runThinkAloud(args, bb);
      case 'mobile_run_draft_steps':
        return await runMobileRunDraftSteps(args, bb, opts);
      case 'mobile_create_test_case':
        return await runMobileCreateTestCase(args, bb, opts);
      case 'list_project_options':
        return await runListProjectOptions(args, bb);
      case 'list_webview_contexts':
        return await runListWebviewContexts(args, bb, opts);
      case 'switch_to_webview':
        return await runSwitchToWebview(args, bb, opts);
      case 'switch_to_native':
        return await runSwitchToNative(args, bb, opts);
      case 'web_evaluate':
        return await runWebEvaluate(args, bb, opts);
      default:
        logger.warn('[MOBILE_TOOLS] Unknown tool', { name });
        return {
          ok: false,
          content: `Unknown tool: ${name}. Available: ${MOBILE_AGENT_TOOLS.map((t) => t.function.name).join(', ')}.`,
        };
    }
  };

  // Phase B7: per-tool metrics. We record AROUND the dispatcher, not
  // inside individual executors, so the counter / histogram surface is
  // automatic for every existing AND future tool. Outcome label
  // distinguishes ok / failed; the `tool` label is the function name.
  // Latency is wall-clock end-to-end (includes I/O to runner) — the
  // value chat operators care about.
  let result: ToolResult;
  try {
    result = await runOne();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startedAt;
    incCounter('mobile_chat.tool_call', `${name}.failed`);
    observeMs(`mobile_chat.tool_call_ms.${name}`, durationMs);
    logger.error('[MOBILE_TOOLS] Tool threw', { tool: name, error: message, durationMs });
    bb.recordToolCall({
      tool: name,
      args,
      ok: false,
      error: message,
      durationMs,
      at: startedAt,
    });
    return {
      ok: false,
      content: `Tool "${name}" failed: ${message}`,
    };
  }
  incCounter('mobile_chat.tool_call', `${name}.${result.ok ? 'ok' : 'failed'}`);
  observeMs(`mobile_chat.tool_call_ms.${name}`, Date.now() - startedAt);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// observe_mobile_page
// ═══════════════════════════════════════════════════════════════════════════

const SNAPSHOT_FRESH_MS = 3_000;

async function runObserveMobilePage(
  args: Record<string, unknown>,
  bb: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const startedAt = Date.now();
  const forceRefresh = args.forceRefresh === true;

  const cached = bb.getSnapshot();
  const age = bb.getSnapshotAgeMs();
  if (!forceRefresh && cached && age !== null && age < SNAPSHOT_FRESH_MS) {
    bb.recordToolCall({
      tool: 'observe_mobile_page',
      args,
      ok: true,
      durationMs: Date.now() - startedAt,
      at: startedAt,
    });
    return { ok: true, content: formatSnapshotForLlm(cached, { cached: true }), data: cached };
  }

  const client = await getMobileRunnerClientForSession(bb.mobileSessionId);
  try {
    const snap = await client.fetchUiState(bb.mobileSessionId, {
      includeTree: false,
      includeScreenshot: true,
      signal: opts?.abortSignal,
      userId: bb.userId,
    });
    bb.setSnapshot(snap);
    bb.recordToolCall({
      tool: 'observe_mobile_page',
      args,
      ok: true,
      durationMs: Date.now() - startedAt,
      at: startedAt,
    });
    return { ok: true, content: formatSnapshotForLlm(snap, { cached: false }), data: snap };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (err instanceof MobileRunnerError) {
      const humanHint =
        err.statusCode === 404
          ? 'The mobile session is no longer active. Ask the user to restart the device.'
          : err.statusCode === 409
          ? 'The screen is unreadable right now (splash / semantics disabled). Wait and retry with forceRefresh=true.'
          : err.statusCode === 503
          ? 'Mobile testing is not enabled on this deployment.'
          : `Runner error ${err.statusCode}: ${err.message}`;
      bb.recordToolCall({
        tool: 'observe_mobile_page',
        args,
        ok: false,
        error: err.message,
        durationMs,
        at: startedAt,
      });
      return { ok: false, content: humanHint };
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Action tools — all go through executeBatchCommands so the runner's smart
// resolver, evidence collection, error classification, and recording hooks
// are consistent with test replay.
// ═══════════════════════════════════════════════════════════════════════════

async function runTapElement(
  args: Record<string, unknown>,
  bb: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const targetDescription = requireString(args, 'targetDescription');
  if (!targetDescription) {
    return { ok: false, content: 'tap_element requires targetDescription.' };
  }
  const longPress = args.longPress === true;

  const command = {
    type: longPress ? 'long_press' : 'tap',
    params: { intent: targetDescription },
  };

  return dispatchSingleCommand(bb, command, {
    toolName: 'tap_element',
    args,
    success: (result) =>
      `Tapped "${targetDescription}"${longPress ? ' (long press)' : ''}` +
      resolvedSuffix(result),
    failure: (result, msg) =>
      `Could not tap "${targetDescription}": ${msg}${evidenceSuffix(result)}`,
    mutating: true,
    interactive: true,
    abortSignal: opts?.abortSignal,
  });
}

async function runTypeText(
  args: Record<string, unknown>,
  bb: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const targetDescription = requireString(args, 'targetDescription');
  const text = requireString(args, 'text');
  if (!targetDescription || text === null) {
    return {
      ok: false,
      content: 'type_text requires both targetDescription and text.',
    };
  }
  const clearFirst = args.clearFirst !== false;
  const isSensitive = args.isSensitive === true;

  const command = {
    type: 'type_text',
    params: {
      intent: targetDescription,
      text,
      clearFirst,
    },
  };

  return dispatchSingleCommand(bb, command, {
    toolName: 'type_text',
    // Mask the typed value in the blackboard's tool trail when sensitive —
    // the trail is surfaced in chat metadata and can leak to logs.
    args: isSensitive ? { ...args, text: '[REDACTED]' } : args,
    success: () =>
      isSensitive
        ? `Typed sensitive value into "${targetDescription}".`
        : `Typed "${truncate(text, 40)}" into "${targetDescription}".`,
    failure: (result, msg) =>
      `Could not type into "${targetDescription}": ${msg}${evidenceSuffix(result)}`,
    mutating: true,
    interactive: true,
    abortSignal: opts?.abortSignal,
  });
}

async function runSwipe(
  args: Record<string, unknown>,
  bb: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const direction = requireString(args, 'direction');
  if (!direction || !['up', 'down', 'left', 'right'].includes(direction)) {
    return {
      ok: false,
      content: 'swipe requires direction ∈ {up, down, left, right}.',
    };
  }

  // Resolve coords from the current snapshot so we know screen dimensions.
  // If no snapshot yet, fetch one — swipe without screen size is meaningless.
  const dims = await ensureScreenDims(bb, opts?.abortSignal);
  if (!dims) {
    return {
      ok: false,
      content: 'Cannot swipe: unable to read screen dimensions. Call observe_mobile_page first.',
    };
  }
  const { width, height } = dims;

  // Standard 60%-of-screen gesture centred on the viewport.
  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);
  const dx = Math.round(width * 0.3);
  const dy = Math.round(height * 0.3);
  const swipeCoords = {
    up: { startX: cx, startY: cy + dy, endX: cx, endY: cy - dy },
    down: { startX: cx, startY: cy - dy, endX: cx, endY: cy + dy },
    left: { startX: cx + dx, startY: cy, endX: cx - dx, endY: cy },
    right: { startX: cx - dx, startY: cy, endX: cx + dx, endY: cy },
  }[direction as 'up' | 'down' | 'left' | 'right']!;

  const command = {
    type: 'swipe',
    params: { ...swipeCoords, durationMs: 300 },
  };

  return dispatchSingleCommand(bb, command, {
    toolName: 'swipe',
    args,
    success: () => `Swiped ${direction}.`,
    failure: (_r, msg) => `Swipe ${direction} failed: ${msg}`,
    mutating: true,
    interactive: true,
    abortSignal: opts?.abortSignal,
  });
}

async function runScroll(
  args: Record<string, unknown>,
  bb: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const direction = requireString(args, 'direction');
  if (!direction || !['up', 'down', 'left', 'right'].includes(direction)) {
    return {
      ok: false,
      content: 'scroll requires direction ∈ {up, down, left, right}.',
    };
  }
  const containerDescription = typeof args.containerDescription === 'string'
    ? args.containerDescription
    : undefined;

  const command: Record<string, unknown> = {
    type: 'scroll',
    params: {
      direction,
      ...(containerDescription ? { selector: containerDescription } : {}),
    },
  };

  return dispatchSingleCommand(bb, command, {
    toolName: 'scroll',
    args,
    success: () =>
      `Scrolled ${direction}${containerDescription ? ` in "${containerDescription}"` : ''}.`,
    failure: (_r, msg) => `Scroll ${direction} failed: ${msg}`,
    mutating: true,
    interactive: true,
    abortSignal: opts?.abortSignal,
  });
}

async function runPressKey(
  args: Record<string, unknown>,
  bb: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const key = requireString(args, 'key');
  if (!key) {
    return { ok: false, content: 'press_key requires key.' };
  }

  // Map logical names → runner keycodes. `back` / `home` have dedicated
  // commands; everything else is press_key with a raw keycode string.
  if (key === 'back') {
    return dispatchSingleCommand(
      bb,
      { type: 'go_back' },
      {
        toolName: 'press_key',
        args,
        success: () => 'Pressed back.',
        failure: (_r, msg) => `Press back failed: ${msg}`,
        mutating: true,
        interactive: true,
        abortSignal: opts?.abortSignal,
      },
    );
  }
  if (key === 'home') {
    return dispatchSingleCommand(
      bb,
      { type: 'go_home' },
      {
        toolName: 'press_key',
        args,
        success: () => 'Pressed home.',
        failure: (_r, msg) => `Press home failed: ${msg}`,
        mutating: true,
        interactive: true,
        abortSignal: opts?.abortSignal,
      },
    );
  }

  return dispatchSingleCommand(
    bb,
    { type: 'press_key', params: { keycode: key } },
    {
      toolName: 'press_key',
      args,
      success: () => `Pressed ${key}.`,
      failure: (_r, msg) => `Press ${key} failed: ${msg}`,
      mutating: true,
      interactive: true,
      abortSignal: opts?.abortSignal,
    },
  );
}

async function runLaunchApp(
  args: Record<string, unknown>,
  bb: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const packageName = requireString(args, 'packageName');
  if (!packageName) {
    return { ok: false, content: 'launch_app requires packageName.' };
  }
  const clearData = args.clearData === true;

  return dispatchSingleCommand(
    bb,
    { type: 'launch_app', params: { packageName, clearData } },
    {
      toolName: 'launch_app',
      args,
      success: () => `Launched ${packageName}${clearData ? ' (cleared data)' : ''}.`,
      failure: (_r, msg) => `Could not launch ${packageName}: ${msg}`,
      mutating: true,
      // Launch can take a few seconds (cold start). Give it the default 30s
      // instead of the 8s interactive budget.
      interactive: false,
      abortSignal: opts?.abortSignal,
    },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PLAN LIFECYCLE TOOLS
// ═══════════════════════════════════════════════════════════════════════════

async function runPlanFlow(
  args: Record<string, unknown>,
  bb: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const startedAt = Date.now();
  const userGoal = requireString(args, 'userGoal') ?? bb.goal;

  const result = await generateFlowPlan({
    userGoal,
    currentScreen: bb.getSnapshot(),
    abortSignal: opts?.abortSignal,
  });

  bb.recordToolCall({
    tool: 'plan_flow',
    args: { userGoal },
    ok: result.ok,
    error: result.ok ? undefined : result.error,
    durationMs: Date.now() - startedAt,
    at: startedAt,
  });

  if (!result.ok || !result.plan) {
    return {
      ok: false,
      content:
        `Planner could not produce a valid plan: ${result.error ?? 'unknown'}. ` +
        `Proceed step-by-step without a plan — observe, then take one action at a time.`,
    };
  }

  // Ambiguity gate: the goal was too vague to plan (no target flow / no
  // acceptance criteria). Do NOT install a plan or author any steps — return
  // the clarifying question so the executor relays it to the user and STOPS.
  // This is the enforcement point the prompt guidance alone can't guarantee.
  if (result.plan.needsClarification) {
    return {
      ok: true,
      content:
        'The goal is too vague to plan without guessing. Do NOT author or run ' +
        'any steps. Ask the user this clarifying question and wait for their ' +
        `reply:\n\n"${result.plan.clarifyingQuestion}"`,
      data: result.plan,
    };
  }

  // Past the clarification gate the schema refine guarantees a non-empty
  // steps[]. Narrow to ConcreteFlowPlan so setPlan + the step count reads are
  // type-safe without optional chaining.
  const plan = result.plan as ConcreteFlowPlan;
  bb.setPlan(plan);

  // Surface a planning-specific timeline row so the UI can render
  // "Plan ready: 5 steps" with the planning step-type instead of the
  // generic tool row. Frontend differentiates icons / styling on
  // `step: 'agent_planning'` vs `agent_executing_tool`.
  //
  // Progress: anchored to whichever is HIGHER between 65% (typical
  // post-plan position, plan_flow is usually round 1-2) and the current
  // round-derived progress. Prevents the rare regression where an LLM
  // re-plans mid-flow at round 12+ and the indicator appears to jump
  // backward to 65% from a higher tool-progress value.
  const roundsSoFar = bb.getToolInvocations().length;
  const planProgress = Math.max(65, mobileToolProgress(roundsSoFar, 30));
  emitMobilePlanningStep(
    bb.chatSessionId,
    `Plan ready: ${plan.steps.length} steps`,
    planProgress,
    {
      sessionId: bb.mobileSessionId,
      stepCount: plan.steps.length,
      goal: plan.goal,
    },
  );

  return {
    ok: true,
    content:
      `Plan installed (${plan.steps.length} steps). Walk it by calling ` +
      `start_plan_step → action tools → finish_plan_step, in order.\n\n` +
      `${bb.formatPlanStatusForLlm()}`,
    data: plan,
  };
}

function runStartPlanStep(
  args: Record<string, unknown>,
  bb: MobileBlackboard,
): ToolResult {
  const stepId = requireNumber(args, 'stepId');
  if (stepId === null) {
    return { ok: false, content: 'start_plan_step requires a numeric stepId.' };
  }
  const plan = bb.getPlan();
  if (!plan) {
    return {
      ok: false,
      content: 'No active plan. Call plan_flow first, or proceed without planning for single-step requests.',
    };
  }
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) {
    return { ok: false, content: `Step ${stepId} not found in the current plan.` };
  }
  bb.markStepStarted(stepId);
  bb.recordToolCall({
    tool: 'start_plan_step',
    args: { stepId },
    ok: true,
    durationMs: 0,
    at: Date.now(),
  });
  return {
    ok: true,
    content:
      `Started step #${step.id}: "${step.intent}".\n` +
      `Verify after: ${step.verify}\n` +
      (step.requiresConfirmation
        ? '⚠️ requiresConfirmation=true — this is destructive. Stop and ask the user before acting.\n'
        : '') +
      `\n${bb.formatPlanStatusForLlm()}`,
    data: step,
  };
}

function runFinishPlanStep(
  args: Record<string, unknown>,
  bb: MobileBlackboard,
): ToolResult {
  const stepId = requireNumber(args, 'stepId');
  const status = requireString(args, 'status');
  const reason = typeof args.reason === 'string' ? args.reason : undefined;

  if (stepId === null) {
    return { ok: false, content: 'finish_plan_step requires a numeric stepId.' };
  }
  if (!status || !['done', 'failed', 'skipped'].includes(status)) {
    return {
      ok: false,
      content: 'finish_plan_step requires status ∈ {done, failed, skipped}.',
    };
  }
  if (!bb.getPlan()) {
    return { ok: false, content: 'No active plan to close out.' };
  }
  if (!bb.getStepState(stepId)) {
    return { ok: false, content: `Step ${stepId} not found in the current plan.` };
  }
  if ((status === 'failed' || status === 'skipped') && !reason) {
    return {
      ok: false,
      content: `finish_plan_step with status=${status} requires a non-empty reason.`,
    };
  }

  if (status === 'done') bb.markStepDone(stepId);
  else if (status === 'failed') bb.markStepFailed(stepId, reason ?? 'unspecified');
  else bb.markStepSkipped(stepId, reason ?? 'unspecified');

  bb.recordToolCall({
    tool: 'finish_plan_step',
    args: { stepId, status, reason },
    ok: true,
    durationMs: 0,
    at: Date.now(),
  });

  const next = bb.getNextActionableStep();
  const nextLine = next
    ? `\nNext actionable step: #${next.id} "${next.intent}".`
    : '\nAll steps closed out. You may now summarise the flow for the user.';
  return {
    ok: true,
    content:
      `Step #${stepId} marked ${status}.\n\n${bb.formatPlanStatusForLlm()}${nextLine}`,
  };
}

/**
 * think_aloud — surface a short LLM thought to the chat UI (and persist
 * to history) without touching the device. Read-only by design.
 *
 * Flow:
 *   1. Sanitise the LLM's text (mask credential-shaped substrings).
 *   2. Truncate twice — short for the WS event, longer for the persisted
 *      trace. The UI gets a snappy preview; history keeps richer context.
 *   3. Append to blackboard's reasoning trace (bounded array).
 *   4. Emit `agent_thinking` so the existing ChatProcessingIndicator
 *      renders it without any frontend changes.
 *
 * Idempotent failure: returns ok=true even if WS emit silently no-ops
 * (no chatSessionId, invalid UUID). The LLM's view of the world is
 * "I shared a thought" — it shouldn't replan because of plumbing issues.
 */
function runThinkAloud(
  args: Record<string, unknown>,
  bb: MobileBlackboard,
): ToolResult {
  const raw = requireString(args, 'thought');
  if (!raw) {
    return {
      ok: false,
      content: 'think_aloud requires a non-empty `thought` string.',
    };
  }

  const sanitized = sanitizeReasoning(raw);
  if (!sanitized.trim()) {
    return { ok: false, content: 'Thought reduced to empty after sanitisation.' };
  }

  const traceText = safeTruncate(sanitized, TRACE_PER_ENTRY);
  const wsPreview = safeTruncate(sanitized, WS_PREVIEW_CHARS);
  const round = bb.getToolInvocations().length + 1;

  bb.appendReasoning({
    round,
    text: traceText,
    at: new Date().toISOString(),
  });

  // Anchor to the current round-derived progress (or 70%, whichever is
  // higher) so the chat indicator never jumps backward when the LLM
  // calls think_aloud after a long-running tool round. 70% is a natural
  // "mid-flow" marker that comfortably sits between observe (60) and
  // final reply (95).
  const thinkProgress = Math.max(70, mobileToolProgress(round, 30));
  emitMobileAgentThinking(bb.chatSessionId, wsPreview, thinkProgress, {
    sessionId: bb.mobileSessionId,
    kind: 'think_aloud',
    round,
  });

  bb.recordToolCall({
    tool: 'think_aloud',
    args: { thoughtChars: traceText.length },
    ok: true,
    durationMs: 0,
    at: Date.now(),
  });

  return {
    ok: true,
    content: 'Thought shared with the user. Continue with the next action.',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTHORING: run draft + persist (Phase 6)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Whitelist of step types accepted by the authoring tool. Combines:
 *   - canonical MobileIntentActionType (storage shape) — `click`, `type`,
 *     `swipe`, `scroll`, `press`, etc.
 *   - runner aliases that toRunnerCommand also handles — `tap`, `type_text`,
 *     `input_text`, `press_key`, `launch_app`.
 * Must be kept in sync with `toRunnerCommand` below: every type here has an
 * explicit case in its switch, and its default branch rejects with a
 * "whitelist and converter are out of sync" message (guarded by a unit
 * test in __tests__/tools.to-runner-command.test.ts).
 */
export const ACCEPTED_STEP_TYPES = new Set<string>([
  // canonical (mirror of MobileIntentActionType — mobile-runner.types.ts:42-62)
  'click', 'type', 'scroll', 'press', 'hover',
  'assert', 'ai_check', 'extract_text', 'navigate', 'wait', 'wait_for', 'screenshot',
  'select', 'check', 'uncheck', 'toggle', 'open', 'close',
  'open_app', 'close_app', 'open_notifications',
  'swipe', 'long_press', 'double_tap', 'drag', 'pinch',
  'go_back', 'go_home', 'dismiss',
  'biometric', 'otp', 'permission', 'clipboard', 'network',
  // runner aliases that toRunnerCommand maps explicitly
  'tap', 'type_text', 'input_text', 'press_key', 'launch_app',
  'assert_visible', 'assert_text', 'permission_dialog',
  // WebView authoring (Phase 8) — these can appear in saved test cases.
  'switch_context',
  'web_navigate', 'web_click', 'web_type', 'web_evaluate',
  'web_assert_element', 'web_assert_text', 'web_get_url', 'web_screenshot',
]);

/**
 * Cache the LLM-supplied steps and (optionally) execute them on the live
 * device via the runner's batch endpoint. Mirrors web's `qa_run_draft_steps`.
 *
 * Returns a per-step pass/fail summary so the LLM can decide whether to
 * proceed to mobile_create_test_case or to retry.
 */
async function runMobileRunDraftSteps(
  args: Record<string, unknown>,
  bb: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const startedAt = Date.now();

  const stepsRaw = Array.isArray(args.steps) ? (args.steps as unknown[]) : null;
  if (!stepsRaw || stepsRaw.length === 0) {
    return { ok: false, content: 'mobile_run_draft_steps requires a non-empty steps array.' };
  }
  if (args.confirm !== true) {
    return {
      ok: false,
      content: 'mobile_run_draft_steps requires confirm=true. Pass true once the user has approved running the draft.',
    };
  }

  // Validate + light-normalise each step. We keep the LLM-provided shape
  // verbatim except for trimming and type coercion — no heuristics that
  // would change semantics. Anything unrecognisable bails the whole batch
  // (better than silently dropping a step).
  const steps: MobileIntentStep[] = [];
  for (let i = 0; i < stepsRaw.length; i++) {
    const r = stepsRaw[i] as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') {
      return { ok: false, content: `Step #${i + 1} is not an object.` };
    }
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `step_${i + 1}`;
    const type = typeof r.type === 'string' ? r.type.trim() : '';
    const description = typeof r.description === 'string' ? r.description.trim() : '';
    if (!type) return { ok: false, content: `Step #${i + 1} (${id}) is missing "type".` };
    if (!description) return { ok: false, content: `Step #${i + 1} (${id}) is missing "description".` };
    if (!ACCEPTED_STEP_TYPES.has(type)) {
      return {
        ok: false,
        content:
          `Step #${i + 1} (${id}) has unknown type "${type}". ` +
          `Use one of: click, type, swipe, scroll, press, long_press, ` +
          `double_tap, go_back, go_home, open_app, close_app, ` +
          `assert_visible, assert_text, wait_for. ` +
          `(Runner aliases tap, type_text, press_key, launch_app also work.)`,
      };
    }
    const step: MobileIntentStep = {
      id,
      type: type as MobileIntentStep['type'],
      description,
      ...(typeof r.value === 'string' ? { value: r.value } : {}),
      // Primary credential signal for save-time sanitisation — must survive
      // the cache → saveFromRecording round-trip.
      ...(r.isSensitive === true ? { isSensitive: true } : {}),
      ...(typeof r.assertionText === 'string' ? { assertionText: r.assertionText } : {}),
      ...(r.bindingHints && typeof r.bindingHints === 'object'
        ? { bindingHints: r.bindingHints as MobileIntentStep['bindingHints'] }
        : {}),
      ...(r.options && typeof r.options === 'object'
        ? { options: r.options as MobileIntentStep['options'] }
        : {}),
      ...(r.expectedOutcome === 'success' || r.expectedOutcome === 'error'
        ? { expectedOutcome: r.expectedOutcome }
        : {}),
    };
    steps.push(step);
  }

  // Convert every step to a runner command BEFORE caching/executing.
  // A step that can't be converted (missing required params, no valid
  // target) bails the whole batch with an actionable message — same
  // policy as the shape validation above.
  const commands: Record<string, unknown>[] = [];
  for (let i = 0; i < steps.length; i++) {
    const converted = toRunnerCommand(steps[i]);
    if (!converted.ok) {
      return {
        ok: false,
        content: `Step #${i + 1} (${steps[i].id}) cannot run: ${converted.reason}`,
      };
    }
    commands.push(converted.command);
  }

  // Persist draft in the cache BEFORE running. If the run errors out
  // mid-flight the user can still ask to save what we have.
  const snapshot = bb.getSnapshot();
  const platform = mapPlatformToMobilePlatform(snapshot?.platform);
  const suggestedName =
    typeof args.suggestedName === 'string' && args.suggestedName.trim()
      ? args.suggestedName.trim()
      : undefined;
  if (bb.chatSessionId) {
    MobileDraftStepsCache.set(bb.chatSessionId, {
      steps,
      mobileSessionId: bb.mobileSessionId,
      platform,
      appPackage: snapshot?.app,
      // activity is android-only; runner's IosSession surfaces undefined
      // for activity already.
      startActivity: snapshot?.activity,
      userId: bb.userId,
      suggestedName,
    });
  }

  // Execute as a single batch. Runner serialises per-session anyway, so
  // batching beats N separate calls — we get one round-trip with built-in
  // smart-wait + per-step results.
  const client = await getMobileRunnerClientForSession(bb.mobileSessionId);
  let runnerResults: unknown[] = [];
  let batchError: string | null = null;
  try {
    const { results } = await client.executeBatchCommands(
      bb.mobileSessionId,
      commands,
      { interactive: false, signal: opts?.abortSignal, userId: bb.userId },
    );
    runnerResults = results ?? [];
  } catch (err) {
    batchError = err instanceof Error ? err.message : String(err);
  }

  // Always invalidate snapshot after a draft run — every step is potentially
  // mutating, so the cached pre-run screen is stale.
  bb.invalidateSnapshot();

  const summary = summariseRunnerResults(steps, runnerResults, batchError);
  bb.recordToolCall({
    tool: 'mobile_run_draft_steps',
    args: {
      stepCount: steps.length,
      suggestedName,
      passed: summary.passed,
      failed: summary.failed,
    },
    ok: summary.failed === 0 && !batchError,
    error: batchError ?? (summary.failed > 0 ? `${summary.failed} step(s) failed` : undefined),
    durationMs: Date.now() - startedAt,
    at: startedAt,
  });

  if (batchError) {
    return {
      ok: false,
      content:
        `Could not run the draft: ${batchError}.\n` +
        `${steps.length} steps were cached for save, but none executed. ` +
        `Tell the user; do not call mobile_create_test_case unless they explicitly ask anyway.`,
    };
  }

  return {
    ok: summary.failed === 0,
    content: summary.report,
    data: { runnerResults, summary },
  };
}

/**
 * Persist the draft cached for this chat session as an intent_test_case.
 * Credential sanitisation (values → `{{param_*}}` placeholders + schema)
 * is enforced by `RegressionSaveService.saveFromRecording` at the
 * persistence boundary — this tool just hands over the raw draft.
 */
async function runMobileCreateTestCase(
  args: Record<string, unknown>,
  bb: MobileBlackboard,
  _opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const startedAt = Date.now();

  if (args.confirm !== true) {
    return {
      ok: false,
      content:
        'mobile_create_test_case requires confirm=true. Only call this when the user explicitly asked to save / persist.',
    };
  }
  if (!bb.chatSessionId) {
    return {
      ok: false,
      content:
        'No chatSessionId on this turn — nothing to look up the draft. The user is talking to a non-persisted chat.',
    };
  }

  // Atomic consume: defends against the rare double-save race when the
  // user hits the button twice. Mirrors web's DraftStepsCache.consume.
  const draft = MobileDraftStepsCache.consume(bb.chatSessionId);
  if (!draft) {
    return {
      ok: false,
      content:
        'No draft to save. The user must run a draft (mobile_run_draft_steps) first, then ask to save it. Drafts also expire after 30 minutes of inactivity.',
    };
  }

  if (!Array.isArray(draft.steps) || draft.steps.length === 0) {
    return { ok: false, content: 'Cached draft is empty — nothing to save.' };
  }

  const name =
    (typeof args.name === 'string' && args.name.trim()) ||
    draft.suggestedName ||
    `Mobile flow ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const description =
    typeof args.description === 'string' ? args.description.trim() : undefined;

  // Sanitisation happens at the persistence boundary —
  // `RegressionSaveService.saveFromRecording` runs `sanitizeMobileSteps` on
  // every mobile save (credential values → `{{param_*}}`, schema persisted
  // to parameters_schema). No pre-sanitisation here: a single boundary pass
  // is what derives the schema.

  // We need a project id. Priority:
  //   1. Explicit `projectId` arg — the recovery path after a failed save,
  //      where the user picked a project from list_project_options. The
  //      value is LLM-relayed and therefore untrusted: validate ownership /
  //      workspace membership before using it.
  //   2. The eager project context the handler resolved onto the blackboard.
  //   3. Legacy lazy lookup on the chat session row (kept as the safety net
  //      for turns where the eager resolution failed transiently).
  let projectId: string | null = null;
  const projectIdArg =
    typeof args.projectId === 'string' && args.projectId.trim()
      ? args.projectId.trim()
      : null;
  if (projectIdArg) {
    const project = await getAccessibleProject(bb.userId, projectIdArg);
    if (!project) {
      MobileDraftStepsCache.set(bb.chatSessionId, draft);
      return {
        ok: false,
        content:
          `Project ${projectIdArg} does not exist or the user has no access to it. ` +
          'The draft is still cached. Call list_project_options and let the user pick a valid project.',
      };
    }
    projectId = project.id;
  } else {
    projectId = bb.getProjectContext()?.projectId ?? (await resolveProjectId(bb));
  }
  if (!projectId) {
    // Re-cache so the user can retry after providing project context.
    MobileDraftStepsCache.set(bb.chatSessionId, draft);
    return {
      ok: false,
      content:
        'Could not resolve a project for this chat session. The draft has been kept in cache. ' +
        'Recovery path: call list_project_options, show the user the available projects, ask which ' +
        'one to save into, then call mobile_create_test_case again with that projectId.',
    };
  }

  // Resolve platform. Priority:
  //   1. Explicit override from the LLM (`platform` arg) — the LLM has the
  //      user's context and can flag "this is a Flutter app" directly.
  //   2. The app's upload-time `detectedFramework` — the authoritative signal.
  //      This is the load-bearing fix: the runner's live ui-state collapses
  //      Flutter to its host platform (android/ios), so without this a Flutter
  //      app's test case saves as `mobile_android`. That then makes the
  //      regression/warmup paths create a plain android session and SKIP
  //      attach-flutter, leaving element resolution blind (empty native tree).
  //   3. Cached draft platform (captured at run time).
  //   4. Default 'mobile_android' (the save validates via DB CHECK anyway).
  const overrideRaw = typeof args.platform === 'string' ? args.platform : null;
  const validOverrides = ['mobile_android', 'mobile_ios', 'mobile_flutter'] as const;
  type SavePlatform = typeof validOverrides[number];
  const override: SavePlatform | null =
    overrideRaw && (validOverrides as readonly string[]).includes(overrideRaw)
      ? (overrideRaw as SavePlatform)
      : null;

  // Derive from the detected framework when the LLM didn't override. The
  // eager project context already carries it when it resolved THIS project —
  // only hit the DB when it didn't (context miss, or explicit projectId arg
  // pointing elsewhere). Failure to read it is non-fatal — fall through to
  // the cached/host value.
  let frameworkPlatform: SavePlatform | null = null;
  if (!override) {
    const eagerCtx = bb.getProjectContext();
    const framework =
      eagerCtx?.projectId === projectId && eagerCtx.detectedFramework
        ? eagerCtx.detectedFramework
        : await MobileAppStorageService.getDetectedFramework(projectId).catch(
            () => undefined,
          );
    if (framework === 'flutter' || framework === 'ios') {
      frameworkPlatform = frameworkToMobilePlatformKey(
        framework,
        draft.platform === 'ios' ? 'ios' : 'android',
      );
    }
  }

  const cachedPlatform: SavePlatform =
    draft.platform === 'ios' ? 'mobile_ios'
    : draft.platform === 'android' ? 'mobile_android'
    // captureUiState collapses flutter/react-native to host platform, so
    // 'flutter' here is theoretical (cache typed loose); treat as android.
    : 'mobile_android';
  const finalPlatform: SavePlatform = override ?? frameworkPlatform ?? cachedPlatform;

  if (frameworkPlatform && frameworkPlatform !== cachedPlatform) {
    logger.info('[mobile_create_test_case] platform derived from detectedFramework', {
      projectId,
      derived: frameworkPlatform,
      cachedHost: cachedPlatform,
    });
  }

  try {
    const result = await RegressionSaveService.saveTestCase({
      userId: bb.userId,
      projectId,
      name,
      description,
      kind: 'standalone',
      platform: finalPlatform,
      steps: draft.steps,
      appPackage: draft.appPackage,
      startActivity: draft.startActivity,
    });

    bb.recordToolCall({
      tool: 'mobile_create_test_case',
      args: { name, stepCount: draft.steps.length, parametersCount: result.parametersCount },
      ok: true,
      durationMs: Date.now() - startedAt,
      at: startedAt,
    });

    const paramsLine = result.parametersCount > 0
      ? `\n${result.parametersCount} sensitive value(s) were parameterised as {{param_*}} placeholders.`
      : '';
    return {
      ok: true,
      content:
        `✅ Saved as "${name}" (id: ${result.savedTestCaseId}, ${draft.steps.length} steps).` +
        paramsLine +
        `\nReplay it later with "run saved ${name}".`,
      data: result,
    };
  } catch (err) {
    // Save failed — restore the cache so the user can retry without losing work.
    MobileDraftStepsCache.set(bb.chatSessionId, draft);
    const message = err instanceof Error ? err.message : String(err);
    bb.recordToolCall({
      tool: 'mobile_create_test_case',
      args: { name, stepCount: draft.steps.length },
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt,
      at: startedAt,
    });
    return { ok: false, content: `Could not save: ${message}. The draft is still cached — the user can retry.` };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Authoring helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Thrown by the per-type converter when a step is structurally valid but
 * cannot produce a runnable command (missing required coordinates, no
 * navigation target, ...). Caught by `toRunnerCommand` and surfaced as an
 * `{ ok: false, reason }` result so the LLM gets an actionable message
 * instead of the runner's generic zod validation error.
 */
class StepConversionError extends Error {}

export type RunnerCommandConversion =
  | { ok: true; command: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Convert an authoring-time MobileIntentStep into the runner's command
 * shape. The mapping accepts BOTH canonical storage types (`click`, `type`,
 * `press`, `open_app`) and runner-aliased types (`tap`, `type_text`,
 * `press_key`, `launch_app`) — the LLM may emit either; we normalise here.
 * Mirrors qait-mobile-runner's intent-step-converter.ts so an authored
 * step converts to the same command a saved test case would replay as.
 * A step that can't produce a runnable command returns `{ ok: false }`
 * with a reason the LLM can fix.
 */
export function toRunnerCommand(step: MobileIntentStep): RunnerCommandConversion {
  try {
    return { ok: true, command: toRunnerCommandInner(step) };
  } catch (err) {
    if (err instanceof StepConversionError) {
      return { ok: false, reason: err.message };
    }
    throw err;
  }
}

function toRunnerCommandInner(step: MobileIntentStep): Record<string, unknown> {
  const type = step.type as string;
  switch (type) {
    // Canonical "tap" family — both storage names ('click' from
    // MobileIntentActionType) and runner names ('tap').
    case 'click':
    case 'tap':
    case 'open':
    case 'toggle':
    case 'check':
    case 'uncheck':
    case 'hover':
    case 'select':
      return { type: 'tap', params: { intent: step.description } };

    // ── close: app vs UI element, decided by structure (runner parity).
    //    A package-like value ("com.example.app") → close_app; otherwise
    //    tap the close button/icon the description names.
    case 'close':
      return isPackageLike(step.value ?? '')
        ? { type: 'close_app', params: { packageName: step.value } }
        : { type: 'tap', params: { intent: step.description } };

    case 'long_press':
      return { type: 'long_press', params: { intent: step.description } };

    case 'double_tap':
      return { type: 'double_tap', params: { intent: step.description } };

    // Text input — both storage ('type') and runner ('type_text', 'input_text').
    case 'type':
    case 'type_text':
    case 'input_text':
      return {
        type: 'type_text',
        params: {
          intent: step.description,
          text: step.value ?? '',
          clearFirst: true,
        },
      };

    case 'scroll':
      return {
        type: 'scroll',
        params: {
          direction: (step.options as { direction?: string } | undefined)?.direction ?? 'down',
        },
      };

    case 'swipe': {
      // Runner zod (swipeParams) requires all four coordinates. Use the
      // LLM-provided coords when complete; otherwise derive them from the
      // direction hint — same geometry as the runner's own
      // inferSwipeCoordinates (centre of a 1080×1920 reference screen,
      // shorter horizontal span to stay clear of Android's edge back-
      // gesture zones).
      const opts = step.options as
        | {
            startX?: number;
            startY?: number;
            endX?: number;
            endY?: number;
            durationMs?: number;
            direction?: 'up' | 'down' | 'left' | 'right';
            scrollDirection?: 'up' | 'down' | 'left' | 'right';
          }
        | undefined;
      const coords =
        opts?.startX != null && opts?.startY != null && opts?.endX != null && opts?.endY != null
          ? { startX: opts.startX, startY: opts.startY, endX: opts.endX, endY: opts.endY }
          : inferSwipeCoordinates(opts?.direction ?? opts?.scrollDirection ?? 'down');
      return {
        type: 'swipe',
        params: { ...coords, durationMs: opts?.durationMs ?? 300 },
      };
    }

    // ── drag: unlike swipe there is no sane default — a drag targets a
    //    specific element pair, so all four coordinates are required
    //    (runner parity: its converter rejects a coordinate-less drag).
    case 'drag': {
      const opts = step.options as
        | { startX?: number; startY?: number; endX?: number; endY?: number; durationMs?: number }
        | undefined;
      if (opts?.startX == null || opts?.startY == null || opts?.endX == null || opts?.endY == null) {
        throw new StepConversionError(
          'drag requires options.startX/startY/endX/endY coordinates.',
        );
      }
      return {
        type: 'drag',
        params: {
          startX: opts.startX,
          startY: opts.startY,
          endX: opts.endX,
          endY: opts.endY,
          holdDurationMs: 500,
          durationMs: opts.durationMs ?? 800,
        },
      };
    }

    // ── pinch: zoom gesture. Runner command name is pinch_zoom.
    case 'pinch': {
      const opts = step.options as
        | { pinchDirection?: 'in' | 'out'; pinchScale?: number; startX?: number; startY?: number }
        | undefined;
      return {
        type: 'pinch_zoom',
        params: {
          direction: opts?.pinchDirection ?? 'out',
          scale: opts?.pinchScale ?? 2.0,
          ...(opts?.startX != null ? { x: opts.startX } : {}),
          ...(opts?.startY != null ? { y: opts.startY } : {}),
        },
      };
    }

    case 'press':
    case 'press_key':
      return {
        type: 'press_key',
        params: {
          keycode:
            (step.options as { key?: string; keycode?: string } | undefined)?.keycode ??
            (step.options as { key?: string } | undefined)?.key ??
            step.value ??
            'enter',
        },
      };

    case 'go_back':
    case 'go_home':
      return { type };

    case 'open_app':
    case 'launch_app':
      return {
        type: 'launch_app',
        params: { packageName: step.value ?? step.description },
      };

    case 'close_app': {
      const opts = step.options as { hard?: boolean } | undefined;
      return {
        type: 'close_app',
        params: {
          ...(step.value ? { packageName: step.value } : {}),
          // Only forward when explicitly true. Absence keeps the runner on
          // its soft default so legacy steps without the flag don't suddenly
          // start wiping app data.
          ...(opts?.hard === true ? { hard: true } : {}),
        },
      };
    }

    case 'assert':
    case 'ai_check':
    case 'assert_visible':
      return {
        type: 'assert_visible',
        params: {
          intent: step.description,
          ...(step.assertionText ? { expectedText: step.assertionText } : {}),
        },
      };
    case 'assert_text':
      return {
        type: 'assert_text',
        params: {
          intent: step.description,
          ...(step.assertionText ? { expectedText: step.assertionText } : {}),
        },
      };

    // ── extract_text: read an element's text into the runner scratchpad.
    //    variableName is required by the runner's zod schema.
    case 'extract_text': {
      const opts = step.options as { extractVariable?: string } | undefined;
      const variableName = opts?.extractVariable?.trim();
      if (!variableName) {
        throw new StepConversionError(
          'extract_text requires options.extractVariable (the scratchpad variable name to store the text under).',
        );
      }
      return {
        type: 'extract_text',
        params: { intent: step.description, variableName },
      };
    }

    // ── navigate: URL / deep link → open_url; package/bundle ID → launch_app.
    //    Mirrors the runner's own navigate handling for saved test cases.
    case 'navigate': {
      const target =
        step.value ??
        (isUrlLike(step.description) || isPackageLike(step.description) ? step.description : '');
      if (!target) {
        throw new StepConversionError(
          'navigate requires a URL, deep link, or package/bundle ID in step.value.',
        );
      }
      return isUrlLike(target)
        ? { type: 'open_url', params: { url: target } }
        : { type: 'launch_app', params: { packageName: target } };
    }

    // ── wait / wait_for: re-snapshot and wait for a stable screen. The
    //    runner replays these as observe_page; a numeric value extends the
    //    timeout (runner parity: max(waitMs + 2000, 5000)).
    case 'wait':
    case 'wait_for': {
      const waitMs = step.value ? parseInt(step.value, 10) : NaN;
      return {
        type: 'observe_page',
        params: {},
        ...(!isNaN(waitMs) && waitMs > 0
          ? { timeout: Math.max(waitMs + 2000, 5000) }
          : {}),
      };
    }

    case 'screenshot':
      return { type: 'screenshot', params: {} };

    case 'open_notifications':
      return { type: 'open_notifications' };

    // ── dismiss: closes top-most modal / sheet / dialog. Runner walks a
    //    fallback chain (Back → scrim-tap → swipe-down). `target` is a
    //    free-text hint, advisory only — runner closes whatever's on top.
    case 'dismiss': {
      const opts = step.options as { dismissTarget?: string } | undefined;
      const target =
        opts?.dismissTarget ??
        (step.description && step.description !== 'dismiss' ? step.description : undefined);
      return {
        type: 'dismiss',
        params: target ? { target } : {},
      };
    }

    // ── biometric: Face ID / Touch ID / fingerprint prompts.
    //    storage shape stores action under `options.biometricAction`;
    //    runner's params shape uses bare `action`. Mirrors runner-side
    //    intent-step-converter logic.
    case 'biometric': {
      const opts = step.options as
        | {
            biometricAction?: 'enroll' | 'match' | 'fail';
            biometricType?: 'fingerprint' | 'faceId' | 'touchId';
            fingerId?: number;
          }
        | undefined;
      return {
        type: 'biometric',
        params: {
          action: opts?.biometricAction ?? 'match',
          ...(opts?.biometricType ? { biometricType: opts.biometricType } : {}),
          ...(opts?.fingerId !== undefined ? { fingerId: opts.fingerId } : {}),
        },
      };
    }

    // ── otp: SMS code / TOTP / clipboard read. The runner has 5 sub-actions;
    //    we forward whatever the LLM asked for. `code` falls back to step.value
    //    so a plain `{type:'otp', value:'123456', options:{otpAction:'type_otp'}}`
    //    works without ceremony.
    case 'otp': {
      const opts = step.options as
        | {
            otpAction?:
              | 'read_sms'
              | 'read_clipboard'
              | 'read_notification'
              | 'generate_totp'
              | 'type_otp';
            totpSecret?: string;
            otpCode?: string;
            otpExtractPattern?: string;
            otpSenderFilter?: string;
          }
        | undefined;
      const otpAction = opts?.otpAction ?? 'read_sms';
      return {
        type: 'otp',
        params: {
          action: otpAction,
          ...(opts?.totpSecret ? { totpSecret: opts.totpSecret } : {}),
          ...(opts?.otpCode || step.value
            ? { code: opts?.otpCode ?? step.value }
            : {}),
          ...(otpAction === 'type_otp' && step.description
            ? { intent: step.description }
            : {}),
          ...(opts?.otpExtractPattern
            ? { extractPattern: opts.otpExtractPattern }
            : {}),
          ...(opts?.otpSenderFilter ? { senderFilter: opts.otpSenderFilter } : {}),
        },
      };
    }

    // ── permission: system permission dialog (allow / deny / allow_always).
    //    storage type is short alias `permission`; runner command name is
    //    the longer `permission_dialog`. Translate.
    case 'permission':
    case 'permission_dialog': {
      const opts = step.options as
        | { permissionAction?: 'allow' | 'deny' | 'allow_always' | 'allow_foreground' | 'allow_once' }
        | undefined;
      return {
        type: 'permission_dialog',
        params: { action: opts?.permissionAction ?? 'allow' },
      };
    }

    // ── clipboard: set when a value is provided, otherwise read.
    case 'clipboard':
      return step.value
        ? { type: 'set_clipboard', params: { text: step.value } }
        : { type: 'get_clipboard', params: {} };

    // ── network: simulate network conditions. Clear vs set decided by
    //    structure (runner parity): explicit networkAction 'clear', or no
    //    preset AND no custom params → clear.
    case 'network': {
      const opts = step.options as
        | {
            networkAction?: string;
            networkPreset?: string;
            networkLatencyMs?: number;
            networkBandwidthKbps?: number;
            networkPacketLossPercent?: number;
          }
        | undefined;
      const hasCustomParams =
        opts?.networkLatencyMs != null ||
        opts?.networkBandwidthKbps != null ||
        opts?.networkPacketLossPercent != null;
      if (opts?.networkAction === 'clear' || (!opts?.networkPreset && !hasCustomParams)) {
        return { type: 'clear_network_condition', params: {} };
      }
      return {
        type: 'set_network_condition',
        params: {
          ...(opts?.networkPreset ? { preset: opts.networkPreset } : {}),
          ...(opts?.networkLatencyMs != null ? { latencyMs: opts.networkLatencyMs } : {}),
          ...(opts?.networkBandwidthKbps != null
            ? { bandwidthKbps: opts.networkBandwidthKbps }
            : {}),
          ...(opts?.networkPacketLossPercent != null
            ? { packetLossPercent: opts.networkPacketLossPercent }
            : {}),
        },
      };
    }

    // ── WebView (Phase 8) ────────────────────────────────────────────
    // Saved test cases recorded in WebView context store these step
    // types in steps_json; replay maps them back to runner commands.
    case 'switch_context': {
      // The LLM authoring path uses our switch_to_webview / switch_to_native
      // tools, which never emit a `switch_context` step. But pre-existing
      // test cases (from explorer / manual recording) might. Honour both.
      const opts = step.options as { context?: 'NATIVE' | 'WEB'; target?: string } | undefined;
      const ctx: 'NATIVE' | 'WEB' =
        opts?.context === 'WEB' || opts?.context === 'NATIVE'
          ? opts.context
          : step.value === 'WEB' || step.description?.toLowerCase().includes('web')
          ? 'WEB'
          : 'NATIVE';
      return { type: 'switch_context', params: { context: ctx } };
    }

    case 'web_navigate':
      return {
        type: 'web_navigate',
        params: { url: step.value ?? step.description },
      };

    case 'web_click':
      return {
        type: 'web_click',
        // Storage convention: a CSS selector lives in `bindingHints.selector`
        // when the step was authored, falling back to description as a
        // selector-shaped string when the LLM emits `web_click` directly.
        params: {
          selector:
            (step.bindingHints as { selector?: string } | undefined)?.selector ??
            step.description,
        },
      };

    case 'web_type':
      return {
        type: 'web_type',
        params: {
          selector:
            (step.bindingHints as { selector?: string } | undefined)?.selector ??
            step.description,
          text: step.value ?? '',
          clearFirst: true,
        },
      };

    case 'web_evaluate':
      return {
        type: 'web_evaluate',
        params: { expression: step.value ?? step.description },
      };

    case 'web_assert_element':
      return {
        type: 'web_assert_element',
        params: {
          selector:
            (step.bindingHints as { selector?: string } | undefined)?.selector ??
            step.description,
        },
      };

    case 'web_assert_text':
      return {
        type: 'web_assert_text',
        params: {
          selector:
            (step.bindingHints as { selector?: string } | undefined)?.selector ??
            step.description,
          expectedText: step.assertionText ?? step.value ?? '',
        },
      };

    case 'web_get_url':
      return { type: 'web_get_url', params: {} };

    case 'web_screenshot':
      return { type: 'web_screenshot', params: {} };

    default:
      // Only reachable when ACCEPTED_STEP_TYPES and this switch drift
      // apart — reject loudly so the gap is named, instead of shipping a
      // half-shaped command the runner rejects with a generic zod error.
      throw new StepConversionError(
        `step type "${type}" passed the whitelist but has no runner command mapping — ` +
          `ACCEPTED_STEP_TYPES and toRunnerCommand are out of sync.`,
      );
  }
}

/** Check if a string looks like a URL or deep link (has a scheme). */
function isUrlLike(s: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s) || /^(tel|mailto|sms|geo):/.test(s);
}

/** Check if a string looks like a package/bundle ID (e.g. "com.example.app"). */
function isPackageLike(s: string): boolean {
  return /^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(s);
}

/**
 * Direction-based default swipe coordinates on a 1080×1920 reference
 * screen — same geometry as the runner's inferSwipeCoordinates. The
 * horizontal span is shorter on purpose: Android 10+ reserves the outer
 * ~24-32dp of each side as a system back-gesture zone, so a wider swipe
 * would be intercepted as "go back" before the app sees it.
 */
function inferSwipeCoordinates(
  direction: 'up' | 'down' | 'left' | 'right',
): { startX: number; startY: number; endX: number; endY: number } {
  const cx = 540, cy = 960;
  const HORIZONTAL_DELTA = 320;
  const VERTICAL_DELTA = 500;
  switch (direction) {
    case 'up':    return { startX: cx, startY: cy + VERTICAL_DELTA, endX: cx, endY: cy - VERTICAL_DELTA };
    case 'down':  return { startX: cx, startY: cy - VERTICAL_DELTA, endX: cx, endY: cy + VERTICAL_DELTA };
    case 'left':  return { startX: cx + HORIZONTAL_DELTA, startY: cy, endX: cx - HORIZONTAL_DELTA, endY: cy };
    case 'right': return { startX: cx - HORIZONTAL_DELTA, startY: cy, endX: cx + HORIZONTAL_DELTA, endY: cy };
  }
}

interface RunSummary {
  passed: number;
  failed: number;
  report: string;
}

/**
 * Shape of one entry in the runner's batch results array. Matches
 * `CommandResult` in qait-mobile-runner/src/types/commands.types.ts:439-483.
 * We type only the fields we surface — anything else flows through
 * untouched as `data` for callers that want raw access.
 */
interface RunnerStepResult {
  success?: boolean;
  error?: string;
  resolvedVia?: string;
  appDisruption?: {
    reason: 'crash' | 'anr' | 'foreground_mismatch' | 'connection_lost';
    expected?: string;
    actual?: string;
    relaunched?: boolean;
  };
  textVerification?: {
    expected?: string;
    actual?: string;
    matched?: boolean;
    retries?: number;
  };
  bugReport?: { summary?: string };
}

function summariseRunnerResults(
  steps: MobileIntentStep[],
  results: unknown[],
  batchError: string | null,
): RunSummary {
  if (batchError) {
    return {
      passed: 0,
      failed: steps.length,
      report: `Batch failed: ${batchError}`,
    };
  }
  let passed = 0;
  let failed = 0;
  const lines: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const r = (results[i] ?? {}) as RunnerStepResult;
    if (r.success) {
      passed++;
      lines.push(`  ✓ #${i + 1} ${step.description}`);
      continue;
    }
    failed++;
    // Build a user-readable failure reason that preserves the most
    // diagnostic signal from the runner. Order matters — appDisruption
    // is the loudest signal (whole app crashed); textVerification is the
    // next loudest (typed value didn't land); bugReport summary is the
    // runner's own narrative; bare `error` is the catch-all.
    const parts: string[] = [];
    if (r.appDisruption) {
      const d = r.appDisruption;
      parts.push(
        `app ${d.reason}` +
          (d.actual ? ` in ${d.actual}` : '') +
          (d.relaunched ? ' (auto-relaunched)' : ''),
      );
    }
    if (r.textVerification && r.textVerification.matched === false) {
      parts.push(
        `text mismatch: expected "${r.textVerification.expected ?? ''}", ` +
          `got "${r.textVerification.actual ?? ''}"`,
      );
    }
    if (r.bugReport?.summary) parts.push(r.bugReport.summary);
    if (r.error) parts.push(r.error);
    if (parts.length === 0) parts.push('unknown failure');

    lines.push(`  ✗ #${i + 1} ${step.description} — ${parts.join('; ')}`);
  }
  const verdict =
    failed === 0
      ? '✅ all steps passed'
      : `⚠️ ${failed} of ${steps.length} step(s) failed`;
  return {
    passed,
    failed,
    report: `Draft run finished: ${verdict}.\n${lines.join('\n')}`,
  };
}

function mapPlatformToMobilePlatform(
  p: 'android' | 'ios' | undefined,
): MobilePlatform {
  // captureUiState collapses Flutter / React-Native sessions to their HOST
  // platform (android/ios), so `p` is one of those when present. If
  // `p` is undefined (snapshot capture failed before this call), we
  // can't tell — default to android as the most common host.
  //
  // Important caveat: this stored draft platform is overridable by the
  // LLM at save time via `mobile_create_test_case({ platform: 'mobile_flutter' })`.
  // The default here is for the typical native-Android case; Flutter / RN
  // tests rely on the LLM (and ultimately the user) flagging the framework.
  if (p === 'ios') return 'ios';
  return 'android';
}

/**
 * Legacy lazy project lookup via the chat session row. The handler now
 * resolves project context eagerly onto the blackboard
 * (`bb.getProjectContext()`); this remains as the fallback for turns where
 * that resolution failed transiently. Returns null when the chat session
 * has no project either — the save tool then points the LLM at
 * list_project_options.
 */
async function resolveProjectId(bb: MobileBlackboard): Promise<string | null> {
  if (!bb.chatSessionId) return null;
  try {
    const { supabaseAdmin } = await import('@/db/supabase');
    const { data, error } = await supabaseAdmin
      .from('chat_sessions')
      .select('project_id')
      .eq('id', bb.chatSessionId)
      .maybeSingle();
    if (error || !data?.project_id) return null;
    return data.project_id as string;
  } catch (err) {
    logger.warn('[MOBILE_AGENT] resolveProjectId failed', {
      chatSessionId: bb.chatSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Recovery tool for the save dead-end: when no project resolves, the LLM
 * calls this to enumerate the workspace's projects, asks the user to pick,
 * then retries mobile_create_test_case with the chosen projectId.
 */
async function runListProjectOptions(
  _args: Record<string, unknown>,
  bb: MobileBlackboard,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const options = await listMobileProjectOptions(bb.workspaceId);

  bb.recordToolCall({
    tool: 'list_project_options',
    args: { count: options.length },
    ok: true,
    durationMs: Date.now() - startedAt,
    at: startedAt,
  });

  if (options.length === 0) {
    return {
      ok: false,
      content:
        'No projects found in this workspace. The user must create a project ' +
        '(and upload a mobile app build) in the dashboard before a test case can be saved.',
    };
  }

  const lines = options.map((o) => {
    const app = o.hasMobileApp
      ? ` — mobile app: ${o.appPackage ?? 'uploaded'}`
      : ' — no mobile app uploaded';
    return `- "${o.name}" (id: ${o.id})${app}`;
  });
  return {
    ok: true,
    content:
      `Projects available for saving (${options.length}):\n${lines.join('\n')}\n` +
      'Show these to the user and ask which project to save into, then call ' +
      'mobile_create_test_case again with that projectId. Prefer projects with a mobile app uploaded.',
    data: { options },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBVIEW TOOLS (Phase 8)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Best-effort WebView listing. The runner doesn't expose a dedicated
 * "list contexts" endpoint yet — discovery happens implicitly when we
 * call switch_context. So this tool's job is informational: tell the
 * LLM whether the current screen looks like it has a WebView and which
 * framework, based on the existing native a11y snapshot.
 *
 * Heuristic:
 *   - If the cached snapshot has `android.webkit.WebView` or
 *     `WKWebView` in its formatted tree → at least one WebView is
 *     visible.
 *   - The runner's `webview-hybrid-hint.ts` already detects framework
 *     (capacitor / cordova / rn-webview / flutter-iaw / unknown) — but
 *     it runs server-side during resolve. We don't expose that state
 *     here; for the LLM, "framework: unknown" is the correct default.
 *
 * For multi-WebView screens (parent app + payment iframe) the runner
 * will pick the foreground WebView when switch_to_webview is called
 * without contextId. A real list endpoint is a future enhancement.
 */
async function runListWebviewContexts(
  _args: Record<string, unknown>,
  bb: MobileBlackboard,
  _opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const snap = bb.getSnapshot();
  if (!snap) {
    return {
      ok: false,
      content:
        'No screen snapshot yet — call observe_mobile_page first, then check for WebViews.',
    };
  }

  // Quick textual scan — the runner's full webview-hybrid-hint detection
  // requires the raw a11y tree (we only have the formatted string here).
  // This is conservative: false negatives possible if the tree was
  // truncated, but we never claim a WebView exists when it doesn't.
  const tree = snap.formattedTree ?? '';
  const hasAndroidWebView = /android\.webkit\.WebView/i.test(tree);
  const hasIosWebView = /WKWebView|XCUIElementTypeWebView/i.test(tree);
  const detected = hasAndroidWebView || hasIosWebView;

  bb.recordToolCall({
    tool: 'list_webview_contexts',
    args: {},
    ok: true,
    durationMs: 0,
    at: Date.now(),
  });

  if (!detected) {
    return {
      ok: true,
      content:
        'No WebView detected in the current screen. If the user expects ' +
        'one, observe_mobile_page again — it may have just appeared.',
      data: { contexts: [] },
    };
  }

  // Heuristic: count distinct `android.webkit.WebView` / `WKWebView`
  // node lines in the formatted tree. Each line is one node, so 2+
  // matches usually means 2+ WebView containers visible. False
  // positives possible (a node listed under multiple classnames) but
  // the signal is good enough to surface "you might have multiple"
  // hint to the LLM. The runner's authoritative count comes through
  // when web_click / web_type actually fails (see dispatchWeb in
  // mobile-runner.ts) — that path attaches the real socket / context
  // count to the error message.
  const androidMatches = tree.match(/android\.webkit\.WebView/gi)?.length ?? 0;
  const iosMatches = tree.match(/WKWebView|XCUIElementTypeWebView/gi)?.length ?? 0;
  const matchCount = Math.max(androidMatches, iosMatches);
  const possiblyMultiple = matchCount > 1;

  const platform = snap.platform;
  return {
    ok: true,
    content:
      `WebView detected on the ${platform} screen` +
      (possiblyMultiple
        ? ` (${matchCount} possible candidates — main app plus modal / overlay).`
        : '.') +
      ` Call switch_to_webview to enter it; the runner picks the foreground ` +
      `WebView automatically. Once inside, observe_mobile_page returns the DOM ` +
      `and tap_element / type_text operate on HTML elements.` +
      (possiblyMultiple
        ? '\nIf the auto-picked WebView returns "element not found", the runner ' +
          'will tell you how many other WebViews are available — at that point ' +
          'ask the user which one to target (e.g. "main app" vs "payment overlay").'
        : '') +
      (platform === 'android'
        ? '\nNote: Android requires a debug build (setWebContentsDebuggingEnabled(true)) — production APKs cannot be inspected.'
        : ''),
    data: {
      contexts: [
        {
          id: 'foreground',
          platform,
          framework: 'unknown',
          possiblyMultiple,
          treeCandidateCount: matchCount,
        },
      ],
    },
  };
}

async function runSwitchToWebview(
  _args: Record<string, unknown>,
  bb: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const startedAt = Date.now();
  if (bb.getWebContext() === 'WEB') {
    return {
      ok: true,
      content: 'Already in WebView context. Use observe_mobile_page to read the DOM.',
    };
  }

  const client = await getMobileRunnerClientForSession(bb.mobileSessionId);
  try {
    // The runner accepts `switch_context({context: 'WEB'})` — pre-Phase-8
    // it threw "unknown command" because the schema rejected it; the
    // schema patch in command.schema.ts opens the gate.
    await client.executeBatchCommands(
      bb.mobileSessionId,
      [{ type: 'switch_context', params: { context: 'WEB' } }],
      { interactive: false, signal: opts?.abortSignal, userId: bb.userId },
    );
    bb.enterWebContext();

    // Best-effort URL probe so the LLM has something to anchor on. Failure
    // here is non-fatal — switch already succeeded.
    let url: string | undefined;
    try {
      const { results } = await client.executeBatchCommands(
        bb.mobileSessionId,
        [{ type: 'web_get_url', params: {} }],
        { interactive: true, signal: opts?.abortSignal, userId: bb.userId },
      );
      const first = results?.[0] as { data?: { url?: string } } | undefined;
      url = first?.data?.url;
      if (url) bb.enterWebContext(url); // refresh stored url
    } catch {
      // ignore
    }

    bb.recordToolCall({
      tool: 'switch_to_webview',
      args: {},
      ok: true,
      durationMs: Date.now() - startedAt,
      at: startedAt,
    });
    return {
      ok: true,
      content:
        `Switched to WebView context.${url ? ` Current URL: ${url}.` : ''} ` +
        `observe_mobile_page now returns the DOM; tap_element / type_text ` +
        `operate on HTML elements.`,
    };
  } catch (err) {
    bb.recordToolCall({
      tool: 'switch_to_webview',
      args: {},
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
      at: startedAt,
    });
    if (err instanceof MobileRunnerError) {
      // Runner pre-flight returns a specific message when the WebView
      // exists but isn't debuggable — pass it through verbatim so the
      // LLM can tell the user to rebuild as debug.
      return { ok: false, content: `Could not enter WebView: ${err.message}` };
    }
    return {
      ok: false,
      content: `Could not enter WebView: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runSwitchToNative(
  _args: Record<string, unknown>,
  bb: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const startedAt = Date.now();
  if (bb.getWebContext() === 'NATIVE') {
    return {
      ok: true,
      content: 'Already in native context.',
    };
  }

  const client = await getMobileRunnerClientForSession(bb.mobileSessionId);
  try {
    await client.executeBatchCommands(
      bb.mobileSessionId,
      [{ type: 'switch_context', params: { context: 'NATIVE' } }],
      { interactive: false, signal: opts?.abortSignal, userId: bb.userId },
    );
    bb.exitWebContext();
    bb.recordToolCall({
      tool: 'switch_to_native',
      args: {},
      ok: true,
      durationMs: Date.now() - startedAt,
      at: startedAt,
    });
    return {
      ok: true,
      content:
        'Switched back to native context. observe_mobile_page returns the ' +
        'native a11y tree; tap_element / type_text operate on UI elements.',
    };
  } catch (err) {
    bb.recordToolCall({
      tool: 'switch_to_native',
      args: {},
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
      at: startedAt,
    });
    return {
      ok: false,
      content: `Could not return to native: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runWebEvaluate(
  args: Record<string, unknown>,
  bb: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const expression = requireString(args, 'expression');
  if (!expression) {
    return { ok: false, content: 'web_evaluate requires `expression`.' };
  }
  if (bb.getWebContext() !== 'WEB') {
    return {
      ok: false,
      content: 'web_evaluate requires WebView context. Call switch_to_webview first.',
    };
  }

  const startedAt = Date.now();
  const client = await getMobileRunnerClientForSession(bb.mobileSessionId);
  try {
    const { results } = await client.executeBatchCommands(
      bb.mobileSessionId,
      [{ type: 'web_evaluate', params: { expression } }],
      { interactive: true, signal: opts?.abortSignal, userId: bb.userId },
    );
    const first = results?.[0] as
      | { success?: boolean; data?: { result?: unknown }; error?: string }
      | undefined;
    bb.recordToolCall({
      tool: 'web_evaluate',
      args: { expressionPreview: expression.slice(0, 80) },
      ok: !!first?.success,
      error: first?.success ? undefined : first?.error,
      durationMs: Date.now() - startedAt,
      at: startedAt,
    });
    if (!first?.success) {
      return {
        ok: false,
        content: `web_evaluate failed: ${first?.error ?? 'unknown error'}`,
      };
    }
    const value = first.data?.result;
    return {
      ok: true,
      content: `Result: ${JSON.stringify(value)}`,
      data: value,
    };
  } catch (err) {
    bb.recordToolCall({
      tool: 'web_evaluate',
      args: { expressionPreview: expression.slice(0, 80) },
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
      at: startedAt,
    });
    return {
      ok: false,
      content: `web_evaluate threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED COMMAND DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════

interface DispatchOpts {
  toolName: string;
  args: Record<string, unknown>;
  success: (result: RunnerCommandResult) => string;
  failure: (result: RunnerCommandResult | null, msg: string) => string;
  /** True for any tool that changes device state. Drops cached snapshot. */
  mutating: boolean;
  /** Use 8s interactive timeout + noRetry. Off for slow things like launch_app. */
  interactive: boolean;
  abortSignal?: AbortSignal;
}

interface RunnerCommandResult {
  success: boolean;
  error?: string;
  durationMs?: number;
  resolvedVia?: string;
  appDisruption?: { reason: string; actual: string; relaunched: boolean };
  textVerification?: { matched: boolean; actual: string; expected: string };
  evidence?: unknown;
  bugReport?: unknown;
}

async function dispatchSingleCommand(
  bb: MobileBlackboard,
  command: unknown,
  opts: DispatchOpts,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const client = await getMobileRunnerClientForSession(bb.mobileSessionId);

  try {
    const { results } = await client.executeBatchCommands(
      bb.mobileSessionId,
      [command],
      {
        interactive: opts.interactive,
        signal: opts.abortSignal,
        userId: bb.userId,
      },
    );
    const result = (results?.[0] ?? null) as RunnerCommandResult | null;

    if (opts.mutating) bb.invalidateSnapshot();

    const ok = !!result?.success;
    const durationMs = Date.now() - startedAt;

    bb.recordToolCall({
      tool: opts.toolName,
      args: opts.args,
      ok,
      error: ok ? undefined : result?.error || 'unknown failure',
      durationMs,
      at: startedAt,
    });

    if (ok && result) {
      return { ok: true, content: opts.success(result), data: result };
    }

    const msg = result?.error || 'unknown failure';
    return {
      ok: false,
      content: opts.failure(result, msg),
      data: result ?? undefined,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    bb.recordToolCall({
      tool: opts.toolName,
      args: opts.args,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs,
      at: startedAt,
    });
    if (opts.mutating) bb.invalidateSnapshot();
    if (err instanceof MobileRunnerError) {
      const hint =
        err.statusCode === 404
          ? 'The mobile session is no longer active.'
          : err.statusCode === 503
          ? 'Mobile testing is not enabled on this deployment.'
          : err.statusCode === 499
          ? 'Request was cancelled by the user.'
          : `Runner error ${err.statusCode}: ${err.message}`;
      return { ok: false, content: opts.failure(null, hint) };
    }
    return {
      ok: false,
      content: opts.failure(null, err instanceof Error ? err.message : String(err)),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function parseArgs(raw: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof raw !== 'string') return raw ?? {};
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

function requireString(
  args: Record<string, unknown>,
  key: string,
): string | null {
  const v = args[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function requireNumber(
  args: Record<string, unknown>,
  key: string,
): number | null {
  const v = args[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // The LLM occasionally ships numerics as strings when JSON-mode is lax.
  if (typeof v === 'string' && v.trim().length > 0) {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function ensureScreenDims(
  bb: MobileBlackboard,
  signal?: AbortSignal,
): Promise<{ width: number; height: number } | null> {
  const snap = bb.getSnapshot();
  if (snap?.screenSize) return snap.screenSize;

  try {
    const fresh = await (await getMobileRunnerClientForSession(bb.mobileSessionId)).fetchUiState(bb.mobileSessionId, {
      includeTree: false,
      includeScreenshot: false,
      signal,
      userId: bb.userId,
    });
    bb.setSnapshot(fresh);
    return fresh.screenSize;
  } catch {
    return null;
  }
}

function resolvedSuffix(result: RunnerCommandResult): string {
  return result.resolvedVia ? ` (resolved via ${result.resolvedVia}).` : '.';
}

function evidenceSuffix(result: RunnerCommandResult | null): string {
  if (!result) return '';
  if (result.appDisruption) {
    const d = result.appDisruption;
    return ` App disruption: ${d.reason} (in ${d.actual})${d.relaunched ? ', relaunched.' : '.'}`;
  }
  if (result.textVerification && !result.textVerification.matched) {
    return ` Text verification mismatch: expected "${result.textVerification.expected}" but field has "${result.textVerification.actual}".`;
  }
  return '';
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function formatSnapshotForLlm(
  snap: import('@/services/mobile/mobile-runner.types').MobileUiState,
  meta: { cached: boolean },
): string {
  const header = [
    `platform: ${snap.platform}`,
    snap.app ? `app: ${snap.app}` : null,
    snap.activity ? `activity: ${snap.activity}` : null,
    `screen: ${snap.screenSize.width}x${snap.screenSize.height}`,
    snap.windowInfo?.keyboardVisible ? 'keyboard: visible' : null,
    snap.windowInfo?.hasDialog ? 'dialog: visible' : null,
    meta.cached ? '(served from this turn\u2019s cache)' : '(freshly captured)',
  ]
    .filter(Boolean)
    .join('\n');

  // MED-3 fix: parity with the eager-inject path
  // (`mobile-context.service.ts:formatMobileSnapshotForChat`). The a11y
  // tree is user-controlled content from arbitrary apps \u2014 it may carry
  // PII (emails / OTPs / cards inside EditText) AND prompt-injection
  // payloads ("Ignore previous instructions" planted in a TextView).
  //
  // Two transforms, in order:
  //   1. redactPii \u2014 env-gated via MOBILE_CHAT_PII_REDACTION (default
  //      ON). Stops user PII visible on screen from leaking to OpenAI/
  //      Gemini logs.
  //   2. wrapUntrusted \u2014 always on. Frames the tree with markers and
  //      strips forged copies of those markers, so the system prompt's
  //      untrusted-content policy applies to it the same way as the
  //      eager-inject block.
  //
  // Order matters: redact FIRST so PII never sits between the markers
  // even briefly, then wrap. The header is OUR text (snap fields are
  // controlled by the runner, not by app content) \u2014 we don't wrap that.
  let body = snap.formattedTree ?? '';
  if (env.MOBILE_CHAT_PII_REDACTION) {
    body = redactPii(body);
  }
  const wrappedBody = wrapUntrusted(body);
  return `${header}\n${wrappedBody}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase B5 — cheap observation executors
// ═══════════════════════════════════════════════════════════════════════════

/**
 * get_foreground — dumpsys / WDA probe, no a11y tree.
 */
async function runGetForeground(
  _args: Record<string, unknown>,
  bb: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const client = await getMobileRunnerClientForSession(bb.mobileSessionId);
  try {
    const res = await client.fetchForeground(bb.mobileSessionId, {
      userId: bb.userId,
      signal: opts?.abortSignal,
    });

    // Compact human-readable result. Order: WARNING first (foreground
    // mismatch is the LLM's #1 signal here), then identity, then state.
    const lines: string[] = [];
    if (res.mismatch) {
      lines.push(`⚠️ FOREGROUND MISMATCH: expected ${res.mismatch.expected}, actual ${res.mismatch.actual}.`);
    }
    if (res.expectedApp) lines.push(`expected: ${res.expectedApp}`);
    const fg = res.foreground;
    lines.push(`screenState: ${fg.screenState}`);
    if (fg.primary) {
      const act = fg.primary.activityName ? ` (${fg.primary.activityName})` : '';
      lines.push(`primary: ${fg.primary.packageName}${act} — kind=${fg.primary.kind}`);
    } else {
      lines.push('primary: <none>');
    }
    lines.push(`platform: ${res.platform}`);
    lines.push(`capturedAt: ${res.capturedAt}`);
    lines.push(`probeMs: ${fg.durationMs}`);

    bb.recordToolCall({
      tool: 'get_foreground',
      args: {},
      ok: true,
      durationMs: fg.durationMs,
      at: Date.now(),
    });
    return {
      ok: true,
      content: lines.join('\n'),
      data: res,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bb.recordToolCall({ tool: 'get_foreground', args: {}, ok: false, error: message, durationMs: 0, at: Date.now() });
    return { ok: false, content: `get_foreground failed: ${message}` };
  }
}

/**
 * get_step_history — in-memory step list from runner, redacted by default.
 */
async function runGetStepHistory(
  args: Record<string, unknown>,
  bb: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const rawLimit = typeof args.limit === 'number' ? args.limit : 10;
  // Runner clamps too, but we pre-clamp here so a buggy/malicious LLM
  // call doesn't even hit the runner with garbage.
  const limit = Math.max(1, Math.min(Math.floor(rawLimit), 50));

  const client = await getMobileRunnerClientForSession(bb.mobileSessionId);
  try {
    // includeRawInputs is HARDCODED to false from the chat path. Raw
    // typed text is only exposed by explicit operator/debug tools —
    // never to the LLM.
    const res = await client.fetchStepHistory(bb.mobileSessionId, {
      limit,
      includeRawInputs: false,
      userId: bb.userId,
      signal: opts?.abortSignal,
    });

    if (res.steps.length === 0) {
      bb.recordToolCall({ tool: 'get_step_history', args: { limit }, ok: true, durationMs: 0, at: Date.now() });
      return { ok: true, content: 'No steps recorded this session yet.', data: res };
    }

    // Compact serialisation — one line per step, easy for the LLM to scan.
    const formatted = res.steps
      .map((s) => {
        const status = s.success ? 'OK' : 'FAIL';
        const err = s.errorMessage ? ` — ${s.errorMessage.slice(0, 100)}` : '';
        // Keep params summary compact; full JSON would bloat the prompt.
        const paramsBrief = compactParams(s.paramsSummary);
        return `[${s.stepIndex}] ${s.commandType} ${paramsBrief} → ${status} (${s.durationMs}ms)${err}`;
      })
      .join('\n');

    bb.recordToolCall({
      tool: 'get_step_history',
      args: { limit },
      ok: true,
      durationMs: 0,
      at: Date.now(),
    });
    return {
      ok: true,
      content: `Recent steps (${res.steps.length}, redacted=${res.redacted}):\n${formatted}`,
      data: res,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bb.recordToolCall({ tool: 'get_step_history', args: { limit }, ok: false, error: message, durationMs: 0, at: Date.now() });
    return { ok: false, content: `get_step_history failed: ${message}` };
  }
}

/** Compact serialiser for a step's params summary — at most ~60 chars. */
function compactParams(p: Record<string, unknown>): string {
  const entries = Object.entries(p).slice(0, 4); // first 4 keys is enough
  if (entries.length === 0) return '{}';
  const parts = entries.map(([k, v]) => {
    const vs = typeof v === 'string' ? JSON.stringify(v) : String(v);
    return `${k}=${vs.length > 40 ? vs.slice(0, 40) + '…' : vs}`;
  });
  return `{${parts.join(', ')}}`;
}

/**
 * get_recent_logs — logcat / unified-log tail with backend PII redaction
 * as defence in depth (the runner's payload cap is already 2KB).
 */
async function runGetRecentLogs(
  args: Record<string, unknown>,
  bb: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const validLevels = ['verbose', 'debug', 'info', 'warn', 'error'] as const;
  type LogLevel = typeof validLevels[number];
  const levelArg = typeof args.level === 'string' ? args.level : 'warn';
  const level: LogLevel = (validLevels.includes(levelArg as LogLevel) ? levelArg : 'warn') as LogLevel;
  const rawLimit = typeof args.limit === 'number' ? args.limit : 100;
  const limit = Math.max(1, Math.min(Math.floor(rawLimit), 500));

  const client = await getMobileRunnerClientForSession(bb.mobileSessionId);
  try {
    const res = await client.fetchRecentLogs(bb.mobileSessionId, {
      level,
      limit,
      userId: bb.userId,
      signal: opts?.abortSignal,
    });

    // Backend-side PII pass — even though runner caps and filters by
    // level, log lines from production apps can contain email / phone /
    // OTP / JWT artefacts. We redact at the chat boundary the same
    // way `formatMobileSnapshotForChat` redacts the a11y tree.
    const redactedLines = env.MOBILE_CHAT_PII_REDACTION
      ? res.lines.map((l) => redactPii(l))
      : res.lines;

    // Wrap as untrusted content — log lines are arbitrary app output.
    // An attacker could plant "ignore previous instructions" inside a
    // log message, so the wrapper + the system-prompt-level
    // UNTRUSTED_CONTENT_INSTRUCTION (added in B-SEC) keep the LLM
    // honest.
    const body = wrapUntrusted(redactedLines.join('\n'));
    const header =
      `Recent logs (platform=${res.platform}, level=${res.level}, lines=${redactedLines.length}` +
      `${res.truncated ? ', payload truncated' : ''}):`;

    bb.recordToolCall({ tool: 'get_recent_logs', args: { level, limit }, ok: true, durationMs: 0, at: Date.now() });
    return {
      ok: true,
      content: `${header}\n${body}`,
      data: res,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bb.recordToolCall({
      tool: 'get_recent_logs',
      args: { level, limit },
      ok: false,
      error: message,
      durationMs: 0,
      at: Date.now(),
    });
    return { ok: false, content: `get_recent_logs failed: ${message}` };
  }
}

/** Per-turn cap on screenshot tools — prevents vision-token burn. */
const SCREENSHOT_BUDGET_PER_TURN = 2;

/**
 * take_screenshot — base64 PNG via runner /ui-state (screenshot only,
 * no tree). Capped per turn — see SCREENSHOT_BUDGET_PER_TURN.
 */
async function runTakeScreenshot(
  _args: Record<string, unknown>,
  bb: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<ToolResult> {
  const taken = bb.screenshotsTakenThisTurn();
  if (taken >= SCREENSHOT_BUDGET_PER_TURN) {
    bb.recordToolCall({ tool: 'take_screenshot', args: {}, ok: false, error: 'budget_exceeded', durationMs: 0, at: Date.now() });
    return {
      ok: false,
      content:
        `Screenshot budget exceeded for this turn (${taken}/${SCREENSHOT_BUDGET_PER_TURN}). ` +
        'Describe what you need in text using observe_mobile_page instead — it returns the a11y ' +
        'tree which usually covers the same information at a fraction of the vision-token cost.',
    };
  }

  const client = await getMobileRunnerClientForSession(bb.mobileSessionId);
  try {
    // Fetch the screenshot via /ui-state — tree omitted because the
    // LLM didn't ask for it. Screenshot ON, tree OFF → cheaper than a
    // full observe.
    const res = await client.fetchUiState(bb.mobileSessionId, {
      includeTree: false,
      includeScreenshot: true,
      userId: bb.userId,
      signal: opts?.abortSignal,
    });

    if (!res.screenshotBase64) {
      bb.recordToolCall({ tool: 'take_screenshot', args: {}, ok: false, error: 'no_screenshot_returned', durationMs: 0, at: Date.now() });
      return {
        ok: false,
        content: 'take_screenshot: runner returned no screenshot (driver / capture failed).',
      };
    }

    // SUCCESS — count this against the budget AFTER the round-trip so
    // a failed call doesn't burn a slot.
    bb.recordScreenshot();
    bb.recordToolCall({ tool: 'take_screenshot', args: {}, ok: true, durationMs: 0, at: Date.now() });

    // The base64 payload is included in `data` (not `content`) so the
    // pipeline can attach it as a multimodal image input on the next
    // LLM call (vision-capable models). `content` is a short text
    // signal so non-vision models still see SOMETHING.
    return {
      ok: true,
      content:
        `Captured screenshot at ${res.capturedAt} (${res.screenSize.width}x${res.screenSize.height}). ` +
        `Used ${taken + 1}/${SCREENSHOT_BUDGET_PER_TURN} of this turn's screenshot budget.`,
      data: {
        screenshotBase64: res.screenshotBase64,
        capturedAt: res.capturedAt,
        screenSize: res.screenSize,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bb.recordToolCall({ tool: 'take_screenshot', args: {}, ok: false, error: message, durationMs: 0, at: Date.now() });
    return { ok: false, content: `take_screenshot failed: ${message}` };
  }
}
