// @ts-nocheck - DOM types (Element/window) inside frame.evaluate() are only
// available in the browser context, not in the ES2020 lib this project compiles
// against. Same convention as snapshot-collector.ts, which this was extracted
// from. The file is otherwise a single pure helper.
/**
 * Durable <iframe> selector derivation — extracted from snapshot-collector.ts
 * (which was already ~3.7k lines) to keep that file from growing further.
 *
 * Given a Playwright Frame, produce a CSS selector for the <iframe> element that
 * owns it (read from the PARENT document) so a saved test case can re-enter the
 * frame via `page.frameLocator(selector)` on replay.
 */

import type { Frame } from 'playwright';
import { logger } from '@/utils/core/logger';

/**
 * Derive a durable CSS selector for the <iframe> element that owns `frame`,
 * read from the PARENT document. Used so a saved test case can re-enter the
 * frame via `page.frameLocator(selector)` on replay. Priority: id → name →
 * src (substring) → positional `nth-of-type`. Returns undefined when the frame
 * has no owning element (top frame) or derivation throws (cross-origin parent,
 * detached) — the caller treats undefined as "no compiled frame scope".
 */
export async function deriveIframeSelector(frame: Frame): Promise<string | undefined> {
  try {
    const handle = await frame.frameElement();
    try {
      const selector = await handle.evaluate((el: Element) => {
        // Escape an IDENT (for #id) — prefer native CSS.escape.
        const cssEscape = (s: string) =>
          (window as any).CSS && typeof (window as any).CSS.escape === 'function'
            ? (window as any).CSS.escape(s)
            : s.replace(/["\\\]]/g, '\\$&');
        // Escape a quoted ATTRIBUTE VALUE (`[name="…"]`): backslash, quote, and
        // `]` (which would otherwise close the attribute selector early).
        const escAttr = (s: string) => s.replace(/["\\\]]/g, '\\$&');

        // `positional: true` marks a fragile (order-dependent) selector so the
        // server can log it — a reorder of iframes between discovery and
        // replay would silently scope to the wrong frame.
        const id = el.getAttribute('id');
        if (id) return { selector: `iframe#${cssEscape(id)}`, positional: false };

        const name = el.getAttribute('name');
        if (name) return { selector: `iframe[name="${escAttr(name)}"]`, positional: false };

        const src = el.getAttribute('src');
        if (src) {
          // Substring match on a stable tail of the src — full src may carry
          // volatile query params, so anchor on the path-ish portion.
          const tail = src.split(/[?#]/)[0].slice(-40);
          if (tail) return { selector: `iframe[src*="${escAttr(tail)}"]`, positional: false };
        }

        // Positional fallback: index among same-tag siblings in the parent.
        const tag = el.tagName.toLowerCase();
        const sameTag = Array.from(el.parentElement?.children || []).filter(
          (c) => c.tagName.toLowerCase() === tag,
        );
        const pos = sameTag.indexOf(el);
        return pos >= 0
          ? { selector: `${tag}:nth-of-type(${pos + 1})`, positional: true }
          : { selector: tag, positional: true };
      });

      if (selector?.positional) {
        logger.debug('[SNAPSHOT_COLLECTOR] iframe selector fell back to positional', {
          selector: selector.selector,
          note: 'fragile if iframe order changes between discovery and replay',
        });
      }
      return selector?.selector || undefined;
    } finally {
      await handle.dispose().catch(() => {});
    }
  } catch {
    return undefined;
  }
}
