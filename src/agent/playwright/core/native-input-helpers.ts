/**
 * Shared helpers for special HTML5 input types.
 *
 * Used by:
 *  - preview-step-apply.service.ts  (editor type action)
 *  - action-executor.ts             (agent setRange / selectDate)
 *  - shadow-dom-handler.ts          (shadow DOM setRange / selectDate)
 *
 * Extracted to eliminate 6× duplication of nativeInputValueSetter +
 * event dispatch pattern.
 */

import type { Locator, Page } from 'playwright';
import { executeCoordinateDrag, type DragCoordinateData } from './drag-helpers';

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export interface NativeInputDetection {
  /** True if this input needs special handling (not standard text fill) */
  isSpecialInput: boolean;
  /** Which execution strategy to use */
  strategy: 'nativeValueSetter' | 'ariaSlider' | 'default';
  /** HTML input type attribute (range, color, date, time, etc.) */
  inputType?: string;
  /** ARIA role for custom widgets */
  role?: string;
}

/** Input types that require nativeInputValueSetter instead of fill()/pressSequentially() */
const SPECIAL_INPUT_TYPES = new Set([
  'range', 'color', 'date', 'time', 'datetime-local', 'month', 'week',
]);

// ───────────────────────────────────────────────────────────────────────────
// Detection
// ───────────────────────────────────────────────────────────────────────────

/**
 * Detect whether an element is a special input that requires native value setting.
 * Runs a quick `locator.evaluate()` (~3-5ms) to check tag, type, and role.
 */
export async function detectSpecialInput(locator: Locator): Promise<NativeInputDetection> {
  const detection = await locator.evaluate((el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el as HTMLInputElement).type?.toLowerCase() || '';
    const role = el.getAttribute('role') || '';
    return { tag, type, role };
  });

  // Native HTML5 special inputs
  if (detection.tag === 'input' && SPECIAL_INPUT_TYPES.has(detection.type)) {
    return {
      isSpecialInput: true,
      strategy: 'nativeValueSetter',
      inputType: detection.type,
    };
  }

  // Custom ARIA sliders (MUI Slider, Ant Slider, rc-slider, etc.)
  if (detection.role === 'slider') {
    return {
      isSpecialInput: true,
      strategy: 'ariaSlider',
      role: 'slider',
    };
  }

  return { isSpecialInput: false, strategy: 'default' };
}

// ───────────────────────────────────────────────────────────────────────────
// Native Value Setter (for <input type="range|color|date|time|...">)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Set value on a native HTML input using the prototype setter.
 *
 * Standard `fill()` doesn't work on range/color/date inputs.
 * This approach:
 * 1. Uses `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set`
 *    to bypass React/Vue wrappers and trigger synthetic event detection
 * 2. Dispatches input + change + blur events (covers React, Vue v-model, Angular ControlValueAccessor)
 *
 * Works with Locator (Playwright) — compatible with iframe-scoped locators.
 */
export async function setNativeInputValue(locator: Locator, value: string): Promise<void> {
  await locator.evaluate((el, val) => {
    const input = el as HTMLInputElement;

    // 1. Focus the element first (some frameworks only listen when focused)
    if (typeof input.focus === 'function') input.focus();

    // 2. Use native prototype setter to bypass React/Vue/Angular value tracking
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value',
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(input, val);
    } else {
      input.value = val;
    }

    // 3. Dispatch events with correct types:
    //    - InputEvent (not Event) for Vue 3 v-model and modern frameworks
    //    - composed: true so events cross Shadow DOM boundaries
    const eventOpts = { bubbles: true, cancelable: true, composed: true };
    try {
      input.dispatchEvent(new InputEvent('input', { ...eventOpts, data: val, inputType: 'insertText' }));
    } catch {
      // Fallback: some older browsers don't support InputEvent constructor
      input.dispatchEvent(new Event('input', eventOpts));
    }
    input.dispatchEvent(new Event('change', eventOpts));
    input.dispatchEvent(new Event('blur', eventOpts));
  }, value);
}

// ───────────────────────────────────────────────────────────────────────────
// ARIA Slider (for custom MUI/Ant/rc-slider with role="slider")
// ───────────────────────────────────────────────────────────────────────────

/**
 * Set value on a custom ARIA slider widget.
 *
 * Custom sliders use divs with role="slider" and aria-valuemin/max/now.
 * Strategy:
 * 1. Read min/max/current from aria attributes
 * 2. Calculate target position as percentage
 * 3. Get bounding box → calculate pixel coordinate on the track
 * 4. Dispatch pointer events at calculated position (MUI/Ant listen for these)
 * 5. Update aria-valuenow
 * 6. Fallback: coordinate-based drag from current thumb to target position
 */
export async function setAriaSliderValue(page: Page, locator: Locator, value: string): Promise<void> {
  const targetValue = parseFloat(value);
  if (!Number.isFinite(targetValue)) {
    throw new Error(`Invalid slider value: "${value}" — must be a number`);
  }

  // Read slider metadata and bounding box
  // NOTE: role="slider" may be on the thumb (MUI) or the track (other libs).
  // We always use the PARENT/TRACK bounding box for coordinate calculation,
  // because the thumb is a small handle (~20px) while the track spans the full range.
  const sliderInfo = await locator.evaluate((el) => {
    const min = parseFloat(el.getAttribute('aria-valuemin') || '0');
    const max = parseFloat(el.getAttribute('aria-valuemax') || '100');
    const current = parseFloat(el.getAttribute('aria-valuenow') || String(min));
    const orientation = el.getAttribute('aria-orientation') || 'horizontal';
    const isRTL = getComputedStyle(el).direction === 'rtl';

    // Find the track element: the slider thumb's parent/grandparent that represents the full range.
    // Heuristic: walk up until we find an element significantly wider/taller than the thumb.
    let track = el;
    const thumbRect = el.getBoundingClientRect();
    const isHorizontal = orientation === 'horizontal';
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const pRect = p.getBoundingClientRect();
      // Track is wider (horizontal) or taller (vertical) than the thumb
      if (isHorizontal ? pRect.width > thumbRect.width * 2 : pRect.height > thumbRect.height * 2) {
        track = p;
        break;
      }
    }
    const rect = track.getBoundingClientRect();
    return {
      min, max, current, orientation, isRTL,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });

  const { min, max, rect, orientation, isRTL } = sliderInfo;

  // Validate bounding box — skip drag if element is invisible
  if (rect.width <= 0 || rect.height <= 0) {
    throw new Error('Slider element has no visible bounding box — cannot drag');
  }

  const clampedValue = Math.max(min, Math.min(max, targetValue));
  const percentage = max === min ? 0 : (clampedValue - min) / (max - min);

  // Calculate current and target coordinates
  let fromX: number, fromY: number, toX: number, toY: number;

  if (orientation === 'vertical') {
    // Vertical: top = max, bottom = min
    const currentPct = max === min ? 0 : (sliderInfo.current - min) / (max - min);
    fromX = rect.x + rect.width / 2;
    fromY = rect.y + rect.height * (1 - currentPct);
    toX = fromX;
    toY = rect.y + rect.height * (1 - percentage);
  } else {
    // Horizontal: left = min, right = max (reversed in RTL)
    const currentPct = max === min ? 0 : (sliderInfo.current - min) / (max - min);
    const effectiveCurrentPct = isRTL ? 1 - currentPct : currentPct;
    const effectiveTargetPct = isRTL ? 1 - percentage : percentage;
    fromX = rect.x + rect.width * effectiveCurrentPct;
    fromY = rect.y + rect.height / 2;
    toX = rect.x + rect.width * effectiveTargetPct;
    toY = fromY;
  }

  // Execute coordinate drag from current position to target
  const dragData: DragCoordinateData = {
    from: { x: Math.round(fromX), y: Math.round(fromY) },
    to: { x: Math.round(toX), y: Math.round(toY) },
  };
  await executeCoordinateDrag(page, dragData);

  // Update aria-valuenow attribute (some frameworks read this)
  await locator.evaluate((el, val) => {
    el.setAttribute('aria-valuenow', String(val));
    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }, clampedValue);
}

// ───────────────────────────────────────────────────────────────────────────
// Swipe gesture (for carousels, mobile-like interactions)
// ───────────────────────────────────────────────────────────────────────────

export type SwipeDirection = 'left' | 'right' | 'up' | 'down';

/**
 * Execute a swipe gesture on an element.
 *
 * Used for carousels (Swiper, Slick, Embla), mobile-like interactions,
 * and any component that listens for touch/pointer drag events.
 *
 * Dispatches pointer events (pointerdown → pointermove × N → pointerup)
 * to simulate a real swipe. Most carousel libraries detect these.
 */
export async function executeSwipe(
  page: Page,
  locator: Locator,
  direction: SwipeDirection,
  distance?: number,
): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Cannot swipe: element has no bounding box');

  // Default distance: 60% of element width/height
  const swipeDistance = distance || (
    (direction === 'left' || direction === 'right')
      ? Math.round(box.width * 0.6)
      : Math.round(box.height * 0.6)
  );

  // Start from center of element
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  let toX = centerX;
  let toY = centerY;

  switch (direction) {
    case 'left':  toX = centerX - swipeDistance; break;
    case 'right': toX = centerX + swipeDistance; break;
    case 'up':    toY = centerY - swipeDistance; break;
    case 'down':  toY = centerY + swipeDistance; break;
  }

  // Execute swipe via two strategies:
  // 1. Mouse events (works for most desktop carousels)
  // 2. Touch events dispatched via evaluate (works for touch-only carousels like Swiper simulateTouch:false)

  // Strategy 1: Mouse-based drag (Chromium auto-synthesizes pointer events)
  const steps = 8;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    const x = centerX + (toX - centerX) * progress;
    const y = centerY + (toY - centerY) * progress;
    await page.mouse.move(x, y, { steps: 1 });
  }
  await page.mouse.up();

  // Strategy 2: Dispatch touch events for touch-only carousels
  // Some libraries (Swiper with simulateTouch:false) ignore mouse/pointer events
  await locator.evaluate((el, coords) => {
    const touch = (x: number, y: number) =>
      new Touch({ identifier: Date.now(), target: el, clientX: x, clientY: y });
    try {
      el.dispatchEvent(new TouchEvent('touchstart', {
        bubbles: true, cancelable: true,
        touches: [touch(coords.fromX, coords.fromY)],
        changedTouches: [touch(coords.fromX, coords.fromY)],
      }));
      el.dispatchEvent(new TouchEvent('touchmove', {
        bubbles: true, cancelable: true,
        touches: [touch(coords.toX, coords.toY)],
        changedTouches: [touch(coords.toX, coords.toY)],
      }));
      el.dispatchEvent(new TouchEvent('touchend', {
        bubbles: true, cancelable: true,
        touches: [],
        changedTouches: [touch(coords.toX, coords.toY)],
      }));
    } catch { /* Touch API not available in some environments */ }
  }, { fromX: centerX, fromY: centerY, toX, toY });
}

// ───────────────────────────────────────────────────────────────────────────
// Coordinate click (for canvas, maps, charts)
// ───────────────────────────────────────────────────────────────────────────

export interface ClickAtCoordinates {
  x: number;
  y: number;
}

/**
 * Parse click-at coordinates from step value.
 * Accepts: "500,300" or "{x:500,y:300}" or JSON object.
 */
export function parseClickAtCoordinates(value: unknown): ClickAtCoordinates | null {
  if (!value) return null;

  // String format: "500,300"
  if (typeof value === 'string') {
    // Try comma-separated
    const commaMatch = value.match(/^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/);
    if (commaMatch) {
      return { x: parseFloat(commaMatch[1]), y: parseFloat(commaMatch[2]) };
    }
    // Try JSON
    try {
      const obj = JSON.parse(value);
      if (typeof obj?.x === 'number' && typeof obj?.y === 'number') {
        return { x: obj.x, y: obj.y };
      }
    } catch { /* not JSON */ }
    return null;
  }

  // Object format
  if (typeof value === 'object' && value !== null && 'x' in value && 'y' in value) {
    const { x, y } = value as any;
    if (typeof x === 'number' && typeof y === 'number') return { x, y };
  }

  return null;
}

/**
 * Click at specific page coordinates (not element-relative).
 * Used for canvas, maps, charts — elements without standard DOM targets.
 */
export async function clickAtCoordinates(page: Page, coords: ClickAtCoordinates): Promise<void> {
  await page.mouse.click(coords.x, coords.y);
}

// ───────────────────────────────────────────────────────────────────────────
// Validation
// ───────────────────────────────────────────────────────────────────────────

/**
 * Soft-validate input value format. Returns warning (not error) — attempt the set anyway.
 */
export function validateInputValue(
  inputType: string,
  value: string,
): { valid: boolean; warning?: string } {
  switch (inputType) {
    case 'range':
    case 'number': {
      const num = parseFloat(value);
      if (!Number.isFinite(num)) return { valid: false, warning: `"${value}" is not a valid number for ${inputType} input` };
      return { valid: true };
    }
    case 'color': {
      if (!/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value)) {
        return { valid: false, warning: `"${value}" is not a valid hex color (expected #RGB or #RRGGBB)` };
      }
      return { valid: true };
    }
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { valid: false, warning: `"${value}" should be YYYY-MM-DD` };
      return { valid: true };
    case 'time':
      if (!/^\d{2}:\d{2}(:\d{2})?$/.test(value)) return { valid: false, warning: `"${value}" should be HH:MM or HH:MM:SS` };
      return { valid: true };
    case 'datetime-local':
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return { valid: false, warning: `"${value}" should be YYYY-MM-DDTHH:MM` };
      return { valid: true };
    case 'month':
      if (!/^\d{4}-\d{2}$/.test(value)) return { valid: false, warning: `"${value}" should be YYYY-MM` };
      return { valid: true };
    case 'week':
      if (!/^\d{4}-W\d{2}$/.test(value)) return { valid: false, warning: `"${value}" should be YYYY-Www` };
      return { valid: true };
    default:
      return { valid: true };
  }
}
