/**
 * Anchors: screen points stored in a resolution-agnostic way.
 *
 * Recording: the point under the cursor is attached to the element there (if it's
 * a reasonably small, uniquely selectable element) as fractions of that element's
 * box, plus a viewport-fraction fallback. Playback resolves the element's CURRENT
 * box, so the firefly lands on "the Explore panel's search box" whatever the
 * screen size, layout or zoom.
 */
import type { Anchor, Area } from "./types";

/** Elements bigger than this share of the viewport are treated as "background" (use the viewport fallback). */
const MAX_ELEMENT_AREA = 0.45;
/** Never anchor to the firefly's own UI. */
const IGNORE = "[data-firefly-ui]";

const vw = () => window.innerWidth;
const vh = () => window.innerHeight;

/** Viewport diagonal in px (speeds are stored per diagonal). */
export const viewportDiagonal = () => Math.hypot(vw(), vh());
/** Shorter viewport side in px (sizes are stored as a fraction of it). */
export const viewportMin = () => Math.min(vw(), vh());

export function resolveAnchor(a: Anchor): { x: number; y: number } {
  if (a.selector) {
    try {
      const el = document.querySelector(a.selector);
      const r = el?.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) {
        return { x: r.left + (a.ex ?? 0.5) * r.width, y: r.top + (a.ey ?? 0.5) * r.height };
      }
    } catch { /* invalid selector → fallback */ }
  }
  return { x: a.vx * vw(), y: a.vy * vh() };
}

/** Viewport-only anchor (no element). */
export function viewportAnchor(x: number, y: number): Anchor {
  return { vx: round(x / vw()), vy: round(y / vh()) };
}

/** Anchor for a screen point, attached to the element under it when that's meaningful. */
export function anchorAt(x: number, y: number): Anchor {
  const base = viewportAnchor(x, y);
  const el = document.elementsFromPoint(x, y).find((e) => !e.closest(IGNORE));
  if (!el) return base;
  const target = pickTarget(el);
  if (!target) return base;
  const r = target.getBoundingClientRect();
  const selector = selectorFor(target);
  if (!selector) return base;
  return { ...base, selector, ex: round((x - r.left) / r.width), ey: round((y - r.top) / r.height) };
}

/** Walk up from the hit element to something worth anchoring to (not too big, has a stable selector). */
function pickTarget(el: Element): Element | null {
  const area = vw() * vh();
  for (let cur: Element | null = el; cur && cur !== document.body; cur = cur.parentElement) {
    const r = cur.getBoundingClientRect();
    if (r.width * r.height > area * MAX_ELEMENT_AREA) return null;
    // Prefer explicitly tagged elements, then ids, then anything uniquely selectable.
    const tagged = cur.closest("[data-tour]");
    if (tagged && tagged.getBoundingClientRect().width * tagged.getBoundingClientRect().height <= area * MAX_ELEMENT_AREA) return tagged;
    if (cur.id || selectorFor(cur)) return cur;
  }
  return null;
}

/**
 * A selector that uniquely matches `el` now. Preference:
 * [data-tour="…"] (add these to important UI for robust tours) → #id → short nth-of-type path.
 */
export function selectorFor(el: Element): string | null {
  const tour = el.getAttribute("data-tour");
  if (tour) return `[data-tour="${CSS.escape(tour)}"]`;
  if (el.id && !/^\d/.test(el.id) && !el.id.includes(":")) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  for (let cur: Element | null = el; cur && cur !== document.body && parts.length < 6; cur = cur.parentElement) {
    if (cur.getAttribute("data-tour")) { parts.unshift(`[data-tour="${CSS.escape(cur.getAttribute("data-tour")!)}"]`); break; }
    if (cur.id && !cur.id.includes(":")) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
    const tag = cur.tagName.toLowerCase();
    const sibs = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur!.tagName) : [];
    parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(cur) + 1})` : tag);
  }
  const sel = parts.join(" > ");
  try {
    return document.querySelectorAll(sel).length === 1 && document.querySelector(sel) === el ? sel : null;
  } catch {
    return null;
  }
}

/** Current screen box of an area. */
export function resolveArea(a: Area): { x0: number; y0: number; x1: number; y1: number } {
  if (a.selector) {
    try {
      const r = document.querySelector(a.selector)?.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) {
        return {
          x0: r.left + (a.ex0 ?? 0) * r.width, y0: r.top + (a.ey0 ?? 0) * r.height,
          x1: r.left + (a.ex1 ?? 1) * r.width, y1: r.top + (a.ey1 ?? 1) * r.height,
        };
      }
    } catch { /* fallback */ }
  }
  return { x0: a.vx0 * vw(), y0: a.vy0 * vh(), x1: a.vx1 * vw(), y1: a.vy1 * vh() };
}

/**
 * Area for a dragged screen box. Anchored to the smallest element that contains the box
 * (so "the Layers panel" stays highlighted wherever it lands on another screen).
 */
export function areaFromBox(x0: number, y0: number, x1: number, y1: number): Area {
  const [ax, bx] = x0 < x1 ? [x0, x1] : [x1, x0], [ay, by] = y0 < y1 ? [y0, y1] : [y1, y0];
  const area: Area = { vx0: round(ax / vw()), vy0: round(ay / vh()), vx1: round(bx / vw()), vy1: round(by / vh()) };
  const tol = 6;
  const el = document.elementsFromPoint((ax + bx) / 2, (ay + by) / 2).find((e) => {
    if (e.closest(IGNORE)) return false;
    const r = e.getBoundingClientRect();
    return r.left - tol <= ax && r.top - tol <= ay && r.right + tol >= bx && r.bottom + tol >= by
      && r.width * r.height <= vw() * vh() * MAX_ELEMENT_AREA * 1.4;
  });
  const sel = el && selectorFor(el.closest("[data-tour]") ?? el);
  if (!el || !sel) return area;
  const target = document.querySelector(sel)!;
  const r = target.getBoundingClientRect();
  return {
    ...area, selector: sel,
    ex0: round((ax - r.left) / r.width), ey0: round((ay - r.top) / r.height),
    ex1: round((bx - r.left) / r.width), ey1: round((by - r.top) / r.height),
  };
}

/**
 * Area that IS a given element (plus `pad` px around it), anchored to that element itself,
 * so it tracks the element even when its container resizes or reflows (task targets).
 */
export function areaForElement(el: Element, pad = 4): Area {
  const r = el.getBoundingClientRect();
  const sel = selectorFor(el);
  if (!sel || r.width <= 0 || r.height <= 0) return areaFromBox(r.left - pad, r.top - pad, r.right + pad, r.bottom + pad);
  const px = pad / r.width, py = pad / r.height;
  return {
    selector: sel, ex0: round(-px), ey0: round(-py), ex1: round(1 + px), ey1: round(1 + py),
    vx0: round((r.left - pad) / vw()), vy0: round((r.top - pad) / vh()), vx1: round((r.right + pad) / vw()), vy1: round((r.bottom + pad) / vh()),
  };
}

const round = (v: number) => Math.round(v * 10000) / 10000;
