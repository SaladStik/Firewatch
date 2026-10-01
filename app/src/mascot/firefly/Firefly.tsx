/**
 * <Firefly/> — pure renderer. Draws exactly the pose it's given; no timers,
 * no state. Drive it with the FireflyController, GSAP, Motion, sliders…
 *
 * Coordinate system: SVG units, body centre at (0,0), +y down.
 */
import { useId } from "react";
import { DEFAULT_CONFIG, DEFAULT_POSE } from "./config";
import type { FireflyConfig, FireflyPose, WingPose, WingSpec } from "./types";

export interface FireflyProps {
  pose?: FireflyPose;
  config?: FireflyConfig;
  /** Rendered width in px (height follows the drawing's aspect). */
  size?: number;
  className?: string;
}

/** Tight frame around the drawing (wings at full spread, antenna tips, lantern). */
const VIEW = { x: -105, y: -92, w: 210, h: 180 };

export function Firefly({ pose = DEFAULT_POSE, config = DEFAULT_CONFIG, size = 160, className }: FireflyProps) {
  const id = useId().replace(/:/g, "");
  const c = config, p = c.palette, R = c.bodyRadius;
  const lanternColor = mix(p.lantern, p.alarmLantern, pose.alarm);
  const glowColor = mix(p.glow, p.alarmGlow, pose.alarm);
  const lantern = Math.max(0, pose.lantern);
  const sx = 1 + pose.squash, sy = 1 - pose.squash;

  return (
    <svg
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
      width={size}
      height={(size * VIEW.h) / VIEW.w}
      className={className}
      style={{ overflow: "visible", display: "block" }}
      aria-label="Firefly"
      role="img"
    >
      <defs>
        <radialGradient id={`${id}-body`} cx="0.38" cy="0.32" r="0.75">
          <stop offset="0%" stopColor={p.bodyLight} />
          <stop offset="55%" stopColor={p.body} />
          <stop offset="100%" stopColor={p.bodyShade} />
        </radialGradient>
        <radialGradient id={`${id}-lantern`} cx="0.5" cy="0.55" r="0.6">
          <stop offset="0%" stopColor={p.lanternCore} />
          <stop offset="55%" stopColor={lanternColor} />
          <stop offset="100%" stopColor={mix(lanternColor, p.band, 0.35)} />
        </radialGradient>
        <radialGradient id={`${id}-halo`}>
          <stop offset="0%" stopColor={glowColor} stopOpacity={0.55 * Math.min(1, lantern)} />
          <stop offset="45%" stopColor={glowColor} stopOpacity={0.18 * Math.min(1, lantern)} />
          <stop offset="100%" stopColor={glowColor} stopOpacity={0} />
        </radialGradient>
        <filter id={`${id}-soft`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur in="SourceGraphic" stdDeviation={c.glow} result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <g transform={`translate(0 ${pose.hover}) rotate(${pose.rotation}) scale(${pose.scale * sx} ${pose.scale * sy})`}>
        {/* ambient light from the lantern */}
        <circle cx={0} cy={R * 1.2} r={R * (1.7 + lantern * 0.5)} fill={`url(#${id}-halo)`} />

        {/* wings — behind the body; lower pair first */}
        <g filter={c.glow ? `url(#${id}-soft)` : undefined}>
          <Wing spec={c.wingLower} pose={pose.wings.lowerL} R={R} side={-1} fill={p.wingFill} edge={p.wingEdge} />
          <Wing spec={c.wingLower} pose={pose.wings.lowerR} R={R} side={1} fill={p.wingFill} edge={p.wingEdge} />
          <Wing spec={c.wingUpper} pose={pose.wings.upperL} R={R} side={-1} fill={p.wingFill} edge={p.wingEdge} />
          <Wing spec={c.wingUpper} pose={pose.wings.upperR} R={R} side={1} fill={p.wingFill} edge={p.wingEdge} />
        </g>

        {/* antennae (bases tuck behind the head) */}
        <Antenna R={R} config={c} side={-1} angle={pose.antennaL} color={p.antenna} tip={p.antennaTip} filter={`url(#${id}-soft)`} />
        <Antenna R={R} config={c} side={1} angle={pose.antennaR} color={p.antenna} tip={p.antennaTip} filter={`url(#${id}-soft)`} />

        {/* abdomen: band + glowing lantern */}
        <g filter={`url(#${id}-soft)`}>
          <ellipse cx={0} cy={R * (0.9 + c.lanternSize * 0.95)} rx={R * c.lanternSize * (0.95 + lantern * 0.05)} ry={R * c.lanternSize * 1.05}
            fill={`url(#${id}-lantern)`} opacity={0.55 + 0.45 * Math.min(1, lantern)} />
        </g>
        <ellipse cx={0} cy={R * 0.9} rx={R * c.lanternSize * 1.08} ry={R * 0.26} fill={p.band} />

        {/* body / head */}
        <circle cx={0} cy={0} r={R} fill={`url(#${id}-body)`} filter={c.glow ? `url(#${id}-soft)` : undefined} />

        <Face pose={pose} config={c} />
      </g>
    </svg>
  );
}

function Wing({ spec, pose, R, side, fill, edge }: { spec: WingSpec; pose: WingPose; R: number; side: 1 | -1; fill: string; edge: string }) {
  const len = spec.length * R, w = spec.width * R;
  const open = 0.5 + 0.5 * clamp(pose.open, 0, 1);
  return (
    <g transform={`scale(${side} 1) translate(${spec.hinge[0] * R} ${spec.hinge[1] * R}) rotate(${spec.angle + pose.lift}) scale(1 ${open})`}>
      <ellipse cx={len / 2} cy={0} rx={len / 2} ry={w / 2} fill={fill} stroke={edge} strokeWidth={2.4} />
      <path d={`M ${len * 0.12} ${w * 0.04} Q ${len * 0.5} ${-w * 0.12} ${len * 0.82} ${-w * 0.02}`} stroke={edge} strokeWidth={1.2} fill="none" opacity={0.6} />
    </g>
  );
}

function Antenna({ R, config, side, angle, color, tip, filter }: {
  R: number; config: FireflyConfig; side: 1 | -1; angle: number; color: string; tip: string; filter: string;
}) {
  const bx = side * R * 0.3, by = -R * 0.82;
  const a = ((config.antennaSpread + angle) * side * Math.PI) / 180;
  const L = config.antennaLength * R;
  const tx = bx + Math.sin(a) * L, ty = by - Math.cos(a) * L;
  // control point bows the stalk outward a little
  const cx = bx + Math.sin(a * 0.35) * L * 0.55, cy = by - Math.cos(a * 0.35) * L * 0.55;
  return (
    <g>
      <path d={`M ${bx} ${by} Q ${cx} ${cy} ${tx} ${ty}`} stroke={color} strokeWidth={R * 0.09} strokeLinecap="round" fill="none" />
      <circle cx={tx} cy={ty} r={R * 0.19} fill={tip} filter={filter} />
    </g>
  );
}

function Face({ pose, config }: { pose: FireflyPose; config: FireflyConfig }) {
  const R = config.bodyRadius, p = config.palette;
  const lx = clamp(pose.lookX, -1, 1) * R * 0.1, ly = clamp(pose.lookY, -1, 1) * R * 0.08;
  const er = config.eyeSize * R, ex = config.eyeSpacing * R, ey = config.eyeY * R;
  const mouthY = R * 0.36 + ly * 0.5, mw = R * 0.24;
  const curve = pose.smile * R * 0.22;
  const open = clamp(pose.mouthOpen, 0, 1) * R * 0.3;

  const eye = (side: 1 | -1, openAmt: number) => {
    const o = clamp(openAmt, 0.06, 1);
    const cx = side * ex + lx, cy = ey + ly;
    return (
      <g key={side}>
        <ellipse cx={cx} cy={cy} rx={er} ry={er * o * 1.05} fill={p.eye} />
        {o > 0.45 && <circle cx={cx + er * 0.32} cy={cy - er * 0.34 * o} r={er * 0.32} fill={p.eyeShine} />}
        {pose.browAmount > 0.01 && (
          <line
            x1={cx - er * 1.1} x2={cx + er * 1.1}
            y1={cy - er * 2 - side * pose.brow * er * 0.7} y2={cy - er * 2 + side * pose.brow * er * 0.7}
            stroke={p.eye} strokeWidth={R * 0.06} strokeLinecap="round" opacity={clamp(pose.browAmount, 0, 1)}
          />
        )}
      </g>
    );
  };

  return (
    <g>
      {pose.blush > 0.01 && (
        <g opacity={clamp(pose.blush, 0, 1) * 0.55}>
          <ellipse cx={-R * 0.58} cy={R * 0.24} rx={R * 0.14} ry={R * 0.08} fill={p.cheek} />
          <ellipse cx={R * 0.58} cy={R * 0.24} rx={R * 0.14} ry={R * 0.08} fill={p.cheek} />
        </g>
      )}
      {eye(-1, pose.eyeOpenL)}
      {eye(1, pose.eyeOpenR)}
      {open > 0.5 ? (
        <path
          d={`M ${-mw + lx} ${mouthY} Q ${lx} ${mouthY + curve} ${mw + lx} ${mouthY} Q ${lx} ${mouthY + curve + open * 2} ${-mw + lx} ${mouthY} Z`}
          fill={p.mouth} stroke={p.mouth} strokeWidth={R * 0.05} strokeLinejoin="round"
        />
      ) : (
        <path d={`M ${-mw + lx} ${mouthY} Q ${lx} ${mouthY + curve * 2} ${mw + lx} ${mouthY}`} stroke={p.mouth} strokeWidth={R * 0.08} strokeLinecap="round" fill="none" />
      )}
    </g>
  );
}

// ---------------------------------------------------------------- helpers
export function clamp(v: number, a: number, b: number) {
  return Math.min(b, Math.max(a, v));
}

/** Blend two #rrggbb colours (rgba strings pass through unblended). */
export function mix(a: string, b: string, t: number): string {
  if (t <= 0 || !a.startsWith("#")) return a;
  if (t >= 1 || !b.startsWith("#")) return t >= 1 ? b : a;
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}
