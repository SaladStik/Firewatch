/**
 * Firefly scripts — recorded / hand-written sequences (tours, tutorials, cameos).
 *
 * Everything is RESOLUTION-AGNOSTIC: no pixel values are stored.
 *   positions → Anchor (an element + where inside it, with a viewport-fraction fallback)
 *   speed     → viewport diagonals per second
 *   size      → fraction of the viewport's shorter side
 * A script recorded on a 4K monitor plays identically (relatively) on 720p.
 */
import type { EmoteName } from "../controller";
import type { MoodName } from "../moods";

export interface Anchor {
  /** CSS selector of the element the point belongs to (preferred when it resolves). */
  selector?: string;
  /** Where inside that element, 0..1 of its width / height. */
  ex?: number;
  ey?: number;
  /** Fallback: position as a fraction of the viewport (0..1). Always present. */
  vx: number;
  vy: number;
}

/** A highlighted region (resolution-agnostic box: element-relative with a viewport fallback). */
export interface Area {
  selector?: string;
  /** Box inside the element, 0..1 of its width / height. */
  ex0?: number; ey0?: number; ex1?: number; ey1?: number;
  /** Fallback box as viewport fractions. Always present. */
  vx0: number; vy0: number; vx1: number; vy1: number;
}

export type ScriptStep =
  /** Fly to a point. `pass` = fly through without stopping (smooth path). `speed` overrides the script default. */
  | { type: "fly"; to: Anchor; speed?: number; pass?: boolean }
  /** Eyes track a point; `at: null` = look ahead again. */
  | { type: "look"; at: Anchor | null }
  | { type: "mood"; mood: MoodName }
  | { type: "emote"; emote: EmoteName }
  /** Speak. The player waits `seconds` (default: scales with text length) before the next step. */
  | { type: "say"; text: string; seconds?: number }
  | { type: "wait"; seconds: number }
  /** Appear (optionally at a point) / disappear. */
  | { type: "show"; at?: Anchor }
  | { type: "hide" }
  /**
   * Tutorial spotlight: dim the screen except `area`, fly beside it, point the lantern at it,
   * say `text` and (if `click`, default true) wait for the viewer to click through.
   * `area: null` clears a persistent spotlight.
   */
  | { type: "spotlight"; area: Area | null; shape?: "rect" | "ellipse"; text?: string; click?: boolean };

export interface FireflyScript {
  version: 1;
  name?: string;
  /** Mascot size as a fraction of min(viewport width, height). */
  size: number;
  /** Default flight speed in viewport diagonals per second. */
  speed: number;
  /** Where he appears when the script starts. */
  start: Anchor;
  steps: ScriptStep[];
}

export const EMPTY_SCRIPT: FireflyScript = {
  version: 1,
  size: 0.11,
  speed: 0.45,
  start: { vx: 0.5, vy: 0.5 },
  steps: [],
};
