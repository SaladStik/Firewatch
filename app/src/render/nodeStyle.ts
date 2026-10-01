/**
 * Resolves the final look of a node: type → status → override → custom styler.
 * Output is linear-RGB floats ready for GPU instance attributes.
 */
import { Color } from "three";
import type { LandClass } from "../geo/landClass";
import { UNFOCUSED_STYLE, NODE_STATUSES, NODE_TYPES, type NodeOverride, type NodeStatus } from "../hex/nodeTypes";

export interface ResolvedStyle {
  line: [number, number, number];
  fill: number;
  pulse: number;
  lift: number;
  pattern: number;
  emphasis: number;
  prop: [number, number, number];
}

export interface StyleContext {
  key: string;
  land: LandClass;
  status: NodeStatus;
  risk: number;
  /** In a region that isn't in focus (slightly greyed). */
  dimmed?: boolean;
}

/** Optional app-level hook to restyle nodes (return a partial to merge). */
export type NodeStyler = (ctx: StyleContext, base: ResolvedStyle) => Partial<ResolvedStyle> | void;

const colorCache = new Map<string, [number, number, number]>();
export function rgb(hex: string): [number, number, number] {
  let c = colorCache.get(hex);
  if (!c) {
    const col = new Color(hex); // sRGB → linear (ColorManagement)
    colorCache.set(hex, (c = [col.r, col.g, col.b]));
  }
  return c;
}

export function resolveStyle(ctx: StyleContext, override?: NodeOverride, styler?: NodeStyler | null): ResolvedStyle {
  const type = NODE_TYPES[ctx.land] ?? NODE_TYPES[0];
  const status = NODE_STATUSES[(override?.status ?? ctx.status) as NodeStatus] ?? NODE_STATUSES[0];
  const line = override?.line ?? status.line ?? type.line;
  const base: ResolvedStyle = {
    line: rgb(line),
    fill: override?.fill ?? status.fill ?? type.fill,
    pulse: override?.pulse ?? status.pulse,
    lift: override?.lift ?? status.lift,
    pattern: type.pattern,
    emphasis: override?.emphasis ?? status.emphasis ?? type.emphasis ?? 0.45,
    prop: rgb(status.propColor ?? type.line),
  };
  if (ctx.dimmed) {
    // Keep the data (fires, risk, land types) but pull it toward grey and down in brightness.
    const g = rgb(UNFOCUSED_STYLE.grey), t = UNFOCUSED_STYLE.desaturate;
    base.line = [base.line[0] + (g[0] - base.line[0]) * t, base.line[1] + (g[1] - base.line[1]) * t, base.line[2] + (g[2] - base.line[2]) * t];
    base.prop = [base.prop[0] + (g[0] - base.prop[0]) * t, base.prop[1] + (g[1] - base.prop[1]) * t, base.prop[2] + (g[2] - base.prop[2]) * t];
    base.emphasis *= UNFOCUSED_STYLE.emphasis;
    base.pulse *= UNFOCUSED_STYLE.emphasis;
  }
  if (styler) Object.assign(base, styler(ctx, base) ?? {});
  return base;
}
