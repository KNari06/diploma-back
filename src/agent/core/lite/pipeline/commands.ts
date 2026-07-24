/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PLAYWRIGHT COMMAND SCHEMAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * OpenAI function-calling tool definitions for browser automation commands.
 * These map 1:1 to the existing ActionExecutor Playwright operations.
 *
 * The Executor LLM calls these as "tool_calls" in its response.
 * CommandExecutor handles actual Playwright execution.
 *
 * Naming: "commands" (not "tools") — these are Playwright browser commands.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { ChatCompletionTool } from 'openai/resources';

/**
 * All Playwright commands available to the Executor agent.
 * Passed as `tools` parameter to OpenAI chat completion.
 */
export const PLAYWRIGHT_COMMANDS: ChatCompletionTool[] = [
  // ── Page Observation ──
  {
    type: 'function',
    function: {
      name: 'observe_page',
      description:
        'Take a snapshot of the current page. Returns: URL, page type, form fields with refs (in DOM order), buttons, links, errors, obstacles, modals. Call this FIRST at the start and after every page change.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },

  // ── Form Interaction ──
  {
    type: 'function',
    function: {
      name: 'fill_field',
      description:
        'Fill a form field with a value. For credential fields (email, password, username, phone), set is_sensitive=true and use any placeholder value — the system will inject real credentials automatically.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'Element ref from observe_page result (e.g. "e5")',
          },
          value: {
            type: 'string',
            description: 'Value to type into the field',
          },
          is_sensitive: {
            type: 'boolean',
            description: 'Set to true for credential fields (email, password, username, phone). System will inject real values.',
          },
        },
        required: ['ref', 'value'],
      },
    },
  },

  // ── Click ──
  {
    type: 'function',
    function: {
      name: 'click_element',
      description: 'Click a button, link, checkbox, radio button, or any interactive element on the page.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'Element ref from observe_page result',
          },
        },
        required: ['ref'],
      },
    },
  },

  // ── Dropdown Select ──
  {
    type: 'function',
    function: {
      name: 'select_option',
      description: 'Select an option from a dropdown/select element by its visible label or value.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'Select element ref from observe_page result',
          },
          value: {
            type: 'string',
            description: 'Option label or value to select',
          },
        },
        required: ['ref', 'value'],
      },
    },
  },

  // ── Toggle (switch, checkbox, radio) ──
  {
    type: 'function',
    function: {
      name: 'toggle_element',
      description: 'Toggle a switch, checkbox, or radio button. Use this instead of click_element for elements with role="switch", role="checkbox", role="radio", or input[type="checkbox"]/input[type="radio"].',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'Element ref from observe_page result',
          },
        },
        required: ['ref'],
      },
    },
  },

  // ── Range/Slider ──
  {
    type: 'function',
    function: {
      name: 'set_range',
      description: 'Set the value of a slider or range input (input[type="range"], role="slider"). Sets the value directly without dragging.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'Slider/range element ref from observe_page result',
          },
          value: {
            type: 'string',
            description: 'Target value to set (e.g. "75", "50")',
          },
        },
        required: ['ref', 'value'],
      },
    },
  },

  // ── Date/Time Input ──
  {
    type: 'function',
    function: {
      name: 'select_date',
      description: 'Set a date, time, or datetime-local input value. Use ISO format: "2024-01-15" for date, "14:30" for time, "2024-01-15T14:30" for datetime-local.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'Date/time input element ref from observe_page result',
          },
          value: {
            type: 'string',
            description: 'Date/time value in ISO format (e.g. "2024-01-15", "14:30", "2024-01-15T14:30")',
          },
        },
        required: ['ref', 'value'],
      },
    },
  },

  // ── Clear Field ──
  {
    type: 'function',
    function: {
      name: 'clear_field',
      description: 'Clear the value of an input field or textarea. Use before fill_field if you need to replace existing content.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'Input/textarea element ref from observe_page result',
          },
        },
        required: ['ref'],
      },
    },
  },

  // ── Keyboard ──
  {
    type: 'function',
    function: {
      name: 'press_key',
      description: 'Press a keyboard key. Common keys: Enter, Escape, Tab, ArrowDown, ArrowUp, Backspace, Delete.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Key name (e.g. "Enter", "Escape", "Tab")',
          },
        },
        required: ['key'],
      },
    },
  },

  // ── Hover ──
  {
    type: 'function',
    function: {
      name: 'hover_element',
      description: 'Hover over an element to trigger tooltip, dropdown menu, or other hover-activated UI. Useful for revealing hidden content.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'Element ref from observe_page result',
          },
        },
        required: ['ref'],
      },
    },
  },

  // ── Scroll (by amount) ──
  {
    type: 'function',
    function: {
      name: 'scroll_page',
      description: 'Scroll the page by a pixel amount in a direction. Use to discover content below the fold or scroll back up.',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['up', 'down'],
            description: 'Scroll direction',
          },
          amount: {
            type: 'number',
            description: 'Pixels to scroll (default: 600)',
          },
        },
        required: ['direction'],
      },
    },
  },

  // ── Scroll to element ──
  {
    type: 'function',
    function: {
      name: 'scroll_to_element',
      description: 'Scroll a specific element into view. Use when you know the ref of an element that is outside the visible viewport.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'Element ref to scroll into view',
          },
        },
        required: ['ref'],
      },
    },
  },

  // ── Navigation ──
  {
    type: 'function',
    function: {
      name: 'navigate_to',
      description: 'Navigate directly to a URL. Only use when no on-page link or button achieves the needed navigation.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Full URL to navigate to (e.g. "https://example.com/login")',
          },
        },
        required: ['url'],
      },
    },
  },

  // ── Wait ──
  {
    type: 'function',
    function: {
      name: 'wait_for_page',
      description:
        'Wait for the page to settle (network idle, animations complete, dynamic content loaded). Use after form submit, navigation, or clicking buttons that trigger page changes.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Why waiting (e.g. "after login form submit", "waiting for dashboard to load")',
          },
        },
        required: ['reason'],
      },
    },
  },

  // ── Terminal: Goal Achieved ──
  {
    type: 'function',
    function: {
      name: 'mark_done',
      description:
        'Signal that the test goal has been achieved. Only call AFTER verifying the goal condition via observe_page. Include evidence from the page proving the goal is met.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Why the goal is considered achieved',
          },
          evidence: {
            type: 'string',
            description: 'What on the page proves the goal is done (e.g. "Dashboard heading visible, URL is /dashboard")',
          },
        },
        required: ['reason', 'evidence'],
      },
    },
  },

  // ── Terminal: Blocked ──
  {
    type: 'function',
    function: {
      name: 'report_blocked',
      description:
        'Signal the test is blocked by something that cannot be automated (CAPTCHA, 2FA, payment wall, external service). Use only when no workaround exists.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'What is blocking progress (e.g. "CAPTCHA verification required", "2FA code needed")',
          },
          blocker_type: {
            type: 'string',
            enum: ['captcha', '2fa', 'payment', 'external_service', 'login_wall', 'other'],
            description: 'Category of the blocker for reporting',
          },
          can_user_help: {
            type: 'boolean',
            description: 'True if a human user could unblock this (e.g. solving CAPTCHA, entering 2FA code). False if permanently blocked.',
          },
        },
        required: ['reason'],
      },
    },
  },
];

/**
 * Deterministic assertion command — offered to the Executor ONLY when
 * assert-authoring is enabled (config-scoped to editor iterative authoring; see
 * PipelineConfig.enableAssertAuthoring). Kept OUT of PLAYWRIGHT_COMMANDS so
 * exploration and any other lite-pipeline caller are unchanged unless they opt in.
 *
 * Read-only: it asserts that an element's visible text contains `expected` — it
 * takes no Playwright action. The handler grounds the assertion against the live
 * page (the value must be present now) and returns the resolved element so a
 * compiled locator plan freezes, giving replay a real selector.
 */
export const ASSERT_TEXT_COMMAND: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'assert_text',
    description:
      'Assert that an element on the page displays an expected value — a deterministic check the test will re-verify on every replay. Use this when the goal implies a specific, checkable value that is VISIBLE in the current page state (an order total, a result count, a displayed price, a confirmation message). Copy the value exactly as shown. Only assert a value you can see now; the command fails (and tells you the real text) if the element does not contain it.',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Ref of the element that displays the value (from observe_page).',
        },
        expected: {
          type: 'string',
          description: 'The exact text the element should contain, e.g. "1 result" or "$126.35". Must be non-empty.',
        },
        description: {
          type: 'string',
          description: 'Optional human-readable description of what is being verified, e.g. "Result count shows one match".',
        },
      },
      required: ['ref', 'expected'],
    },
  },
};

/**
 * Command names that don't require a page snapshot for execution.
 * Used by CommandExecutor to decide whether to collect a snapshot.
 */
export const SNAPSHOT_FREE_COMMANDS = new Set([
  'observe_page',
  'wait_for_page',
  'navigate_to',
  'mark_done',
  'report_blocked',
]);
