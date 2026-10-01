/**
 * <Firefly/> — pure renderer. Draws exactly the pose it's given; no timers,
 * no state. Drive it with the FireflyController, GSAP, Motion, sliders…
 *
 * Coordinate system: SVG units, body centre at (0,0), +y down, +z toward the viewer.
 *
 * `pose.turn` rotates him in 3D around his vertical axis: the body is a sphere
 * (looks the same from every side), face features slide around its surface,
 * wings and antennae swing round at their own depth and are drawn in front of
 * or behind the body by depth. No flat "card flip".
 */
import { useId, type ReactNode } from "react";
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
/** Wings sit slightly behind the body's centre plane (fraction of body radius). */
const WING_DEPTH = -0.3;

/** 3D turn around the vertical axis. */
interface Turn { cos: number; sin: number }
const projX = (t: Turn, x: number, z: number) => x * t.cos + z * t.sin;
const projZ = (t: Turn, x: number, z: number) => -x * t.sin + z * t.cos;
/** SVG transform that maps a flat part lying at depth z through the turn. */
const flatAt = (t: Turn, z: number) => `translate(${z * t.sin} 0) scale(${Math.abs(t.cos) < 1e-3 ? 1e-3 : t.cos} 1)`;

export function Firefly({ pose = DEFAULT_POSE, config = DEFAULT_CONFIG, size = 160, className }: FireflyProps) {
  const id = useId().replace(/:/g, "");
  const c = config, p = c.palette, R = c.bodyRadius;
  const lanternColor = mix(p.lantern, p.alarmLantern, pose.alarm);
  const glowColor = mix(p.glow, p.alarmGlow, pose.alarm);
  const lantern = Math.max(0, pose.lantern);
  const sx = 1 + pose.squash, sy = 1 - pose.squash;
  const th = (pose.turn * Math.PI) / 180;
  const turn: Turn = { cos: Math.cos(th), sin: Math.sin(th) };
  const soft = c.glow ? `url(#${id}-soft)` : undefined;

  // Depth-sorted parts: z < 0 is drawn behind the body, z ≥ 0 in front of it.
  const parts: { z: number; el: ReactNode }[] = [];

  // ---- wings
  const wing = (key: string, spec: WingSpec, wp: WingPose, side: 1 | -1) => {
    const midX = side * (spec.hinge[0] + (spec.length / 2) * Math.cos((spec.angle * Math.PI) / 180)) * R;
    parts.push({
      z: projZ(turn, midX, WING_DEPTH * R) - 0.01 * spec.length, // larger wings a hair further back
      el: (
        <g key={key} transform={flatAt(turn, WING_DEPTH * R)} filter={soft}>
          <Wing spec={spec} pose={wp} R={R} side={side} fill={p.wingFill} edge={p.wingEdge} />
        </g>
      ),
    });
  };
  wing("wlL", c.wingLower, pose.wings.lowerL, -1);
  wing("wlR", c.wingLower, pose.wings.lowerR, 1);
  wing("wuL", c.wingUpper, pose.wings.upperL, -1);
  wing("wuR", c.wingUpper, pose.wings.upperR, 1);

  // ---- antennae (rooted on the sphere's upper front)
  for (const side of [-1, 1] as const) {
    const a = antennaGeom(R, c, side, side < 0 ? pose.antennaL : pose.antennaR);
    const z = sphereZ(R, a.bx, a.by);
    parts.push({
      z: projZ(turn, a.tx, z) + 0.001,
      el: (
        <g key={`ant${side}`}>
          <path transform={flatAt(turn, z)} d={`M ${a.bx} ${a.by} Q ${a.cx} ${a.cy} ${a.tx} ${a.ty}`} stroke={p.antenna} strokeWidth={R * 0.09} strokeLinecap="round" fill="none" />
          <circle cx={projX(turn, a.tx, z)} cy={a.ty} r={R * 0.19} fill={p.antennaTip} filter={soft} />
        </g>
      ),
    });
  }

  // ---- air effects (spin whirl): streak arcs on rings around him
  if (pose.whirl > 0.01) whirl(parts, pose, R, p.wingEdge, glowColor, soft);

  const back = parts.filter((x) => x.z < 0).sort((a, b) => a.z - b.z);
  const front = parts.filter((x) => x.z >= 0).sort((a, b) => a.z - b.z);

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

      <g transform={`translate(${pose.offsetX} ${pose.hover}) rotate(${pose.rotation}) scale(${pose.scale * sx} ${pose.scale * sy})`}>
        {/* ambient light from the lantern */}
        <circle cx={0} cy={R * 1.2} r={R * (1.7 + lantern * 0.5)} fill={`url(#${id}-halo)`} />

        {back.map((x) => x.el)}

        {/* abdomen: band + glowing lantern (on the spin axis, so unaffected by turn) */}
        <g filter={`url(#${id}-soft)`}>
          <ellipse cx={0} cy={R * (0.9 + c.lanternSize * 0.95)} rx={R * c.lanternSize * (0.95 + lantern * 0.05)} ry={R * c.lanternSize * 1.05}
            fill={`url(#${id}-lantern)`} opacity={0.55 + 0.45 * Math.min(1, lantern)} />
        </g>
        <ellipse cx={0} cy={R * 0.9} rx={R * c.lanternSize * 1.08} ry={R * 0.26} fill={p.band} />

        {/* body / head — a sphere, identical from every angle */}
        <circle cx={0} cy={0} r={R} fill={`url(#${id}-body)`} filter={soft} />

        <Face pose={pose} config={c} turn={turn} />

        {front.map((x) => x.el)}
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

function antennaGeom(R: number, config: FireflyConfig, side: 1 | -1, angle: number) {
  const bx = side * R * 0.3, by = -R * 0.82;
  const a = ((config.antennaSpread + angle) * side * Math.PI) / 180;
  const L = config.antennaLength * R;
  const tx = bx + Math.sin(a) * L, ty = by - Math.cos(a) * L;
  // control point bows the stalk outward a little
  const cx = bx + Math.sin(a * 0.35) * L * 0.55, cy = by - Math.cos(a * 0.35) * L * 0.55;
  return { bx, by, tx, ty, cx, cy };
}

/** Depth of the sphere surface under a front-view point. */
function sphereZ(R: number, x: number, y: number) {
  return Math.sqrt(Math.max(0, R * R - x * x - y * y));
}

/**
 * Places a flat face feature (centred at cx,cy on the sphere's front) after the turn:
 * slides it around the surface, narrows it toward the limb, hides it on the far side.
 */
function OnSphere({ R, turn, cx, cy, children }: { R: number; turn: Turn; cx: number; cy: number; children: ReactNode }) {
  const z = sphereZ(R, cx, cy);
  const ring = Math.sqrt(Math.max(1e-6, R * R - cy * cy)); // radius of the latitude circle
  const facing = projZ(turn, cx, z) / ring; // cos of the feature's longitude after the turn
  if (facing <= 0.02) return null;
  const x = projX(turn, cx, z);
  return (
    <g transform={`translate(${x} 0) scale(${facing} 1) translate(${-cx} 0)`} opacity={clamp(facing * 4, 0, 1)}>
      {children}
    </g>
  );
}

function Face({ pose, config, turn }: { pose: FireflyPose; config: FireflyConfig; turn: Turn }) {
  const R = config.bodyRadius, p = config.palette;
  // Gaze moves the whole eye (and a little of the mouth) across the face.
  const lx = clamp(pose.lookX, -1, 1) * R * 0.16, ly = clamp(pose.lookY, -1, 1) * R * 0.12;
  const er = config.eyeSize * R, ex = config.eyeSpacing * R, ey = config.eyeY * R;
  const mouthY = R * 0.36 + ly * 0.5, mw = R * 0.24;
  const curve = pose.smile * R * 0.22;
  const open = clamp(pose.mouthOpen, 0, 1) * R * 0.3;

  const eye = (side: 1 | -1, openAmt: number) => {
    const o = clamp(openAmt, 0.06, 1);
    const cx = side * ex + lx, cy = ey + ly;
    return (
      <OnSphere key={side} R={R} turn={turn} cx={cx} cy={cy}>
        <ellipse cx={cx} cy={cy} rx={er} ry={er * o * 1.05} fill={p.eye} />
        {/* catch-lights: a reflection of a fixed light source, so they stay upper-right
            (gaze is shown by the whole eye moving, not the glint) */}
        {o > 0.45 && <circle cx={cx + er * 0.32} cy={cy - er * 0.34 * o} r={er * 0.32} fill={p.eyeShine} />}
        {o > 0.6 && <circle cx={cx - er * 0.3} cy={cy + er * 0.36 * o} r={er * 0.13} fill={p.eyeShine} opacity={0.85} />}
        {pose.browAmount > 0.01 && (
          <line
            x1={cx - er * 1.1} x2={cx + er * 1.1}
            y1={cy - er * 2 - side * pose.brow * er * 0.7} y2={cy - er * 2 + side * pose.brow * er * 0.7}
            stroke={p.eye} strokeWidth={R * 0.06} strokeLinecap="round" opacity={clamp(pose.browAmount, 0, 1)}
          />
        )}
      </OnSphere>
    );
  };

  return (
    <g>
      {pose.blush > 0.01 && ([-1, 1] as const).map((s) => (
        <OnSphere key={`b${s}`} R={R} turn={turn} cx={s * R * 0.58} cy={R * 0.24}>
          <ellipse cx={s * R * 0.58} cy={R * 0.24} rx={R * 0.14} ry={R * 0.08} fill={p.cheek} opacity={clamp(pose.blush, 0, 1) * 0.55} />
        </OnSphere>
      ))}
      {eye(-1, pose.eyeOpenL)}
      {eye(1, pose.eyeOpenR)}
      <OnSphere R={R} turn={turn} cx={lx} cy={mouthY}>
        {open > 0.5 ? (
          <path
            d={`M ${-mw + lx} ${mouthY} Q ${lx} ${mouthY + curve} ${mw + lx} ${mouthY} Q ${lx} ${mouthY + curve + open * 2} ${-mw + lx} ${mouthY} Z`}
            fill={p.mouth} stroke={p.mouth} strokeWidth={R * 0.05} strokeLinejoin="round"
          />
        ) : (
          <path d={`M ${-mw + lx} ${mouthY} Q ${lx} ${mouthY + curve * 2} ${mw + lx} ${mouthY}`} stroke={p.mouth} strokeWidth={R * 0.08} strokeLinecap="round" fill="none" />
        )}
      </OnSphere>
    </g>
  );
}

/**
 * Spin air effects: streaks travelling round three horizontal rings (seen in
 * perspective as ellipses) plus sparkles at their heads. Each streak is split
 * at the rim so its far half goes behind the body and its near half in front.
 */
function whirl(parts: { z: number; el: ReactNode }[], pose: FireflyPose, R: number, streak: string, spark: string, soft?: string) {
  const rings = [
    { y: -0.55, rx: 1.45, speed: 1.0, n: 3 },
    { y: 0.2, rx: 1.75, speed: 1.25, n: 3 },
    { y: 0.95, rx: 1.3, speed: 0.85, n: 2 },
  ];
  const w = clamp(pose.whirl, 0, 1);
  rings.forEach((ring, ri) => {
    const rx = ring.rx * R * (0.85 + 0.15 * w), ry = rx * 0.24, cy = ring.y * R;
    for (let k = 0; k < ring.n; k++) {
      const head = -pose.whirlPhase * ring.speed + (k * Math.PI * 2) / ring.n + ri * 0.9;
      const len = 1.3 + 1.0 * w; // radians of arc behind the head
      // Sample the arc; break it where it crosses the rim (front ↔ back).
      let seg: string[] = [];
      let segFront: boolean | null = null;
      const flush = (key: string) => {
        if (seg.length > 1 && segFront !== null) {
          parts.push({
            z: segFront ? R * 2 : -R * 2,
            el: <path key={key} d={`M ${seg.join(" L ")}`} stroke={streak} strokeWidth={segFront ? 3.2 : 2.2} strokeLinecap="round" fill="none" opacity={Math.min(1, w * 1.3) * (segFront ? 0.95 : 0.45)} filter={soft} />,
          });
        }
        seg = [];
      };
      const steps = 14;
      for (let i = 0; i <= steps; i++) {
        const t = head + (len * i) / steps;
        const front = Math.sin(t) > 0; // +sin = lower half of the ellipse = toward the viewer
        if (segFront !== null && front !== segFront) {
          const last = seg[seg.length - 1];
          flush(`s${ri}${k}${i}`);
          if (last) seg.push(last);
        }
        segFront = front;
        seg.push(`${(Math.cos(t) * rx).toFixed(1)} ${(cy + Math.sin(t) * ry).toFixed(1)}`);
      }
      flush(`s${ri}${k}e`);
      // sparkle at the streak head
      const hz = Math.sin(head);
      parts.push({
        z: hz > 0 ? R * 2.1 : -R * 2.1,
        el: <circle key={`p${ri}${k}`} cx={Math.cos(head) * rx} cy={cy + hz * ry} r={R * (0.07 + 0.05 * w)} fill={spark} opacity={w * (hz > 0 ? 1 : 0.5)} filter={soft} />,
      });
    }
  });
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
