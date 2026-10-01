/**
 * Firefly mascot — data contracts.
 *
 * FireflyConfig = how he LOOKS (colours, proportions). Change once, rarely.
 * FireflyPose   = what he's DOING right now. Every field is animatable on its
 *                 own; the renderer just draws whatever pose it is given.
 */

export interface FireflyPalette {
  body: string;
  bodyLight: string;
  bodyShade: string;
  wingFill: string;
  wingEdge: string;
  eye: string;
  eyeShine: string;
  mouth: string;
  cheek: string;
  antenna: string;
  antennaTip: string;
  band: string;
  lantern: string;
  lanternCore: string;
  glow: string;
  /** Lantern + glow colours blended in by `pose.alarm` (fire alert). */
  alarmLantern: string;
  alarmGlow: string;
}

export interface WingSpec {
  /** Length from hinge to tip, in body radii. */
  length: number;
  /** Width, in body radii. */
  width: number;
  /** Resting angle in degrees (0 = straight out, negative = up). */
  angle: number;
  /** Hinge position relative to body centre, in body radii (right side; mirrored on the left). */
  hinge: [number, number];
}

export interface FireflyConfig {
  palette: FireflyPalette;
  /** Body radius in SVG units (the whole drawing scales around this). */
  bodyRadius: number;
  wingUpper: WingSpec;
  wingLower: WingSpec;
  /** Antenna length in body radii, resting spread from vertical (degrees). */
  antennaLength: number;
  antennaSpread: number;
  /** Eye radius, half-spacing and vertical offset, in body radii. */
  eyeSize: number;
  eyeSpacing: number;
  eyeY: number;
  /** Lantern (glowing abdomen) radius in body radii. */
  lanternSize: number;
  /** Blur radius of the soft glow (SVG units). 0 disables it. */
  glow: number;
}

/** One wing's instantaneous state. */
export interface WingPose {
  /** Degrees added to the resting angle (negative = raise). */
  lift: number;
  /** 0..1 apparent width (foreshortening as the wing turns). */
  open: number;
}

export interface FireflyPose {
  // ---- placement (used by FireflyAgent; the bare <Firefly/> ignores x/y)
  x: number;
  y: number;
  /** Extra vertical offset in px (hover bob), separate from the flight position. */
  hover: number;
  /** Extra horizontal offset in px (e.g. orbiting during a spin), separate from the flight position. */
  offsetX: number;
  /**
   * Turn around the vertical axis in degrees (0 = facing you, 180 = back to you).
   * Rendered with real depth: the body is a sphere, face features slide around it,
   * wings/antennae swing round in front of or behind the body.
   */
  turn: number;
  /** 0..1 strength of the spin "air" effect (swirling streaks + sparkles). */
  whirl: number;
  /** Phase (radians) of the whirl streaks — advance it to make them travel. */
  whirlPhase: number;
  /** Whole-body tilt in degrees (banking). */
  rotation: number;
  scale: number;
  /** Squash & stretch: +0.2 = wider/shorter, -0.2 = taller/thinner. */
  squash: number;

  // ---- wings (each one independent)
  wings: { upperL: WingPose; upperR: WingPose; lowerL: WingPose; lowerR: WingPose };

  // ---- antennae: degrees from rest (negative = toward the centre)
  antennaL: number;
  antennaR: number;

  // ---- face
  eyeOpenL: number; // 0 closed .. 1 open
  eyeOpenR: number;
  /** Where he looks, -1..1 on each axis. */
  lookX: number;
  lookY: number;
  /** -1 frown .. 1 big smile. */
  smile: number;
  /** 0 closed .. 1 wide open. */
  mouthOpen: number;
  /** -1 angry/determined slant .. 1 worried slant. */
  brow: number;
  /** Brow visibility 0..1. */
  browAmount: number;
  blush: number;

  // ---- light
  /** Lantern brightness 0..1.5. */
  lantern: number;
  /** 0 normal colours .. 1 full fire-alert colours. */
  alarm: number;
}
