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
import { getMobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import {
  MobileRunnerError,
  type MobileIntentStep,
  type MobilePlatform,
} from '@/services/mobile/mobile-runner.types';
import { logger } from '@/utils/core/logger';
import type { MobileBlackboard } from './blackboard';
import { generateFlowPlan } from './planner';
import { MobileDraftStepsCache } from '@/services/testing/mobile/mobile-draft-steps-cache';
import { sanitizeMobileSteps } from '@/services/testing/mobile/mobile-step-sanitizer';
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
      'flags. Call this BEFORE acting or answering anything about the UI, and AGAIN ' +
      'after any action to see the post-action state. Safe to call multiple times — ' +
      'read-only.',
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
      'After planning, walk the plan via start_plan_step / finish_plan_step.',
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

export const MOBILE_AGENT_TOOLS: ChatCompletionTool[] = [
  OBSERVE_MOBILE_PAGE_TOOL,
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

  try {
    switch (name) {
      case 'observe_mobile_page':
        return await runObserveMobilePage(args, bb, opts);
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
      default:
        logger.warn('[MOBILE_TOOLS] Unknown tool', { name });
        return {
          ok: false,
          content: `Unknown tool: ${name}. Available: ${MOBILE_AGENT_TOOLS.map((t) => t.function.name).join(', ')}.`,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[MOBILE_TOOLS] Tool threw', {
      tool: name,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    bb.recordToolCall({
      tool: name,
      args,
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt,
      at: startedAt,
    });
    return {
      ok: false,
      content: `Tool "${name}" failed: ${message}`,
    };
  }
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

  const client = getMobileRunnerClient();
  try {
    const snap = await client.fetchUiState(bb.mobileSessionId, {
      includeTree: false,
      includeScreenshot: true,
      signal: opts?.abortSignal,
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

  bb.setPlan(result.plan);

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
    `Plan ready: ${result.plan.steps.length} steps`,
    planProgress,
    {
      sessionId: bb.mobileSessionId,
      stepCount: result.plan.steps.length,
      goal: result.plan.goal,
    },
  );

  return {
    ok: true,
    content:
      `Plan installed (${result.plan.steps.length} steps). Walk it by calling ` +
      `start_plan_step → action tools → finish_plan_step, in order.\n\n` +
      `${bb.formatPlanStatusForLlm()}`,
    data: result.plan,
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
 * Must be kept in sync with `toRunnerCommand` below; an unknown type would
 * fall through to the catch-all branch and the runner would reject it,
 * leaving the LLM with a vague "unknown failure".
 */
const ACCEPTED_STEP_TYPES = new Set<string>([
  // canonical (mirror of MobileIntentActionType — mobile-runner.types.ts:42-62)
  'click', 'type', 'scroll', 'press', 'hover',
  'assert', 'ai_check', 'navigate', 'wait', 'wait_for', 'screenshot',
  'select', 'check', 'uncheck', 'toggle', 'open', 'close',
  'open_app', 'close_app', 'open_notifications',
  'swipe', 'long_press', 'double_tap', 'drag', 'pinch',
  'go_back', 'go_home', 'dismiss',
  'biometric', 'otp', 'permission', 'clipboard', 'network',
  // runner aliases that toRunnerCommand maps explicitly
  'tap', 'type_text', 'input_text', 'press_key', 'launch_app',
  'assert_visible', 'assert_text', 'permission_dialog',
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
  const client = getMobileRunnerClient();
  let runnerResults: unknown[] = [];
  let batchError: string | null = null;
  try {
    const { results } = await client.executeBatchCommands(
      bb.mobileSessionId,
      steps.map(toRunnerCommand),
      { interactive: false, signal: opts?.abortSignal },
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
 * Sanitises sensitive values (password / token / secret / ...) BEFORE
 * insert by replacing matched values with `{{param_*}}` placeholders.
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

  // Sanitise sensitive values BEFORE handing to the save service.
  // saveFromRecording does NOT sanitise (parity with web step-editor authoring),
  // so this is the only line of defence against persisting plaintext credentials.
  const { steps: sanitised, parametersSchema } = sanitizeMobileSteps(draft.steps);

  // We need a project id. The mobile-agent context is project-aware via
  // the chat session; but we don't carry it on the blackboard yet. Fall
  // back to looking it up on the chat session row.
  const projectId = await resolveProjectId(bb);
  if (!projectId) {
    // Re-cache so the user can retry after providing project context.
    MobileDraftStepsCache.set(bb.chatSessionId, draft);
    return {
      ok: false,
      content:
        'Could not resolve a project for this chat session. The draft has been kept in cache — ask the user to confirm the project and retry.',
    };
  }

  // Resolve platform. Priority:
  //   1. Explicit override from the LLM (`platform` arg) — needed for Flutter
  //      / React-Native because the runner's ui-state reports the host
  //      platform (android/ios), not the framework. The LLM has the user's
  //      context and can flag "this is a Flutter app".
  //   2. Cached draft platform (captured at run time).
  //   3. Default 'mobile_android' as a safe fallback (the save will validate
  //      via DB CHECK constraint anyway).
  const overrideRaw = typeof args.platform === 'string' ? args.platform : null;
  const validOverrides = ['mobile_android', 'mobile_ios', 'mobile_flutter'] as const;
  type SavePlatform = typeof validOverrides[number];
  const override: SavePlatform | null =
    overrideRaw && (validOverrides as readonly string[]).includes(overrideRaw)
      ? (overrideRaw as SavePlatform)
      : null;
  const cachedPlatform: SavePlatform =
    draft.platform === 'ios' ? 'mobile_ios'
    : draft.platform === 'android' ? 'mobile_android'
    // captureUiState collapses flutter/react-native to host platform, so
    // 'flutter' here is theoretical (cache typed loose); treat as android.
    : 'mobile_android';
  const finalPlatform: SavePlatform = override ?? cachedPlatform;

  try {
    const result = await RegressionSaveService.saveTestCase({
      userId: bb.userId,
      projectId,
      name,
      description,
      kind: 'standalone',
      platform: finalPlatform,
      steps: sanitised,
      appPackage: draft.appPackage,
      startActivity: draft.startActivity,
    });

    bb.recordToolCall({
      tool: 'mobile_create_test_case',
      args: { name, stepCount: sanitised.length, parametersCount: Object.keys(parametersSchema).length },
      ok: true,
      durationMs: Date.now() - startedAt,
      at: startedAt,
    });

    const paramsLine = Object.keys(parametersSchema).length > 0
      ? `\nSensitive values were parameterised: ${Object.keys(parametersSchema).join(', ')}.`
      : '';
    return {
      ok: true,
      content:
        `✅ Saved as "${name}" (id: ${result.savedTestCaseId}, ${sanitised.length} steps).` +
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
      args: { name, stepCount: sanitised.length },
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
 * Convert an authoring-time MobileIntentStep into the runner's command
 * shape. The mapping accepts BOTH canonical storage types (`click`, `type`,
 * `press`, `open_app`) and runner-aliased types (`tap`, `type_text`,
 * `press_key`, `launch_app`) — the LLM may emit either; we normalise here.
 * Anything we don't recognise gets shipped verbatim — the runner's zod
 * schema rejects it cleanly with an error result the LLM can react to.
 */
function toRunnerCommand(step: MobileIntentStep): Record<string, unknown> {
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

    case 'swipe':
      // Swipe needs explicit start/end coords; without options we ship
      // whatever options the LLM provided (runner validates).
      return {
        type: 'swipe',
        params: (step.options as Record<string, unknown> | undefined) ?? {},
      };

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

    case 'close_app':
      return {
        type: 'close_app',
        params: step.value ? { packageName: step.value } : {},
      };

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
        | { permissionAction?: 'allow' | 'deny' | 'allow_always' }
        | undefined;
      return {
        type: 'permission_dialog',
        params: { action: opts?.permissionAction ?? 'allow' },
      };
    }

    default:
      // Unknown — let the runner reject it. Don't silently drop.
      return { type, params: { intent: step.description } };
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
 * Best-effort project lookup via the chat session. The blackboard doesn't
 * carry projectId today; rather than wire it through every layer for one
 * tool, we ask the DB. If the chat session has no project, returns null
 * and the tool surfaces a "no project" message to the LLM.
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
  const client = getMobileRunnerClient();

  try {
    const { results } = await client.executeBatchCommands(
      bb.mobileSessionId,
      [command],
      {
        interactive: opts.interactive,
        signal: opts.abortSignal,
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
    const fresh = await getMobileRunnerClient().fetchUiState(bb.mobileSessionId, {
      includeTree: false,
      includeScreenshot: false,
      signal,
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
  return `${header}\n${snap.formattedTree}`;
}
