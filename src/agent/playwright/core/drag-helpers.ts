/**
 * Shared drag & drop helpers.
 *
 * Used by:
 *  - command-executor.ts       (regression replay)
 *  - preview-step-apply.service.ts (editor Apply All)
 *
 * Extracted to eliminate 3× duplication of coordinate normalisation +
 * mouse.move/down/up sequence.
 */

import type { Page } from 'playwright';

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export interface DragCoordinateData {
  from: { x: number; y: number };
  to:   { x: number; y: number };
  viewport?: { width: number; height: number };
}

// ───────────────────────────────────────────────────────────────────────────
// Parsing
// ───────────────────────────────────────────────────────────────────────────

/**
 * Parse a drag value (JSON string or pre-parsed object) into typed coordinates.
 * Returns `null` when the value is missing, not JSON, or lacks `from`/`to`.
 */
export function parseDragCoordinates(value: unknown): DragCoordinateData | null {
  if (!value) return null;

  const obj = typeof value === 'string'
    ? (() => { try { return JSON.parse(value); } catch { return null; } })()
    : value;

  if (!obj || typeof obj !== 'object') return null;
  if (!('from' in obj) || !('to' in obj)) return null;
  const { from, to, viewport } = obj as any;
  if (
    typeof from?.x !== 'number' || typeof from?.y !== 'number' ||
    typeof to?.x   !== 'number' || typeof to?.y   !== 'number'
  ) return null;

  return {
    from: { x: from.x, y: from.y },
    to:   { x: to.x,   y: to.y },
    viewport: viewport?.width && viewport?.height
      ? { width: viewport.width, height: viewport.height }
      : undefined,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Execution
// ───────────────────────────────────────────────────────────────────────────

/**
 * Execute a coordinate-based drag & drop on `page`.
 *
 * 1. Normalises coordinates when the current viewport differs from the
 *    viewport at recording time.
 * 2. Moves to the source point, presses mouse, moves gradually to the
 *    target point, releases.
 * 3. Always releases the mouse on failure (prevents "stuck" state).
 */
export async function executeCoordinateDrag(
  page: Page,
  drag: DragCoordinateData,
): Promise<void> {
  let fromX = drag.from.x;
  let fromY = drag.from.y;
  let toX   = drag.to.x;
  let toY   = drag.to.y;

  // Viewport normalisation
  if (drag.viewport) {
    const cur = page.viewportSize();
    if (cur && (cur.width !== drag.viewport.width || cur.height !== drag.viewport.height)) {
      const sX = cur.width  / drag.viewport.width;
      const sY = cur.height / drag.viewport.height;
      fromX = Math.round(fromX * sX);
      fromY = Math.round(fromY * sY);
      toX   = Math.round(toX * sX);
      toY   = Math.round(toY * sY);
    }
  }

  // Gradual move — one intermediate point per ~10px of distance
  const steps = Math.max(5, Math.round(
    Math.sqrt(Math.pow(toX - fromX, 2) + Math.pow(toY - fromY, 2)) / 10,
  ));

  try {
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(toX, toY, { steps });
    await page.mouse.up();
  } catch (err) {
    // Safety: always release mouse to prevent stuck-down state
    await page.mouse.up().catch(() => {});
    throw err;
  }
}
