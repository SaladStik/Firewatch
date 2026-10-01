/**
 * Moods = personality presets as data. Each sets face targets (eased toward)
 * and motion parameters for the controller's procedural layers.
 * Add a mood: add an entry. Nothing else changes.
 */
export interface MoodSpec {
  label: string;
  face: {
    eyeOpen?: number;
    smile?: number;
    mouthOpen?: number;
    brow?: number;
    browAmount?: number;
    blush?: number;
    lookY?: number;
  };
  /** Wing beats per second and swing (degrees). */
  flapHz: number;
  flapAmp: number;
  /** Resting wing lift (degrees, negative = raised). */
  wingLift: number;
  /** Hover bob height (px) and speed (Hz). */
  bob: number;
  bobHz: number;
  /** Lantern base brightness, pulse depth and speed. */
  lantern: number;
  pulseAmt: number;
  pulseHz: number;
  /** 0..1 fire-alert colours. */
  alarm: number;
  /** Antenna droop/perk in degrees (negative = perk up / inward). */
  antenna: number;
  /** Constant tilt in degrees (e.g. head tilt when curious). */
  tilt: number;
  /** Small idle wiggle (degrees) — jitter for alert, sway for happy. */
  wiggle: number;
}

const base: MoodSpec = {
  label: "",
  face: { eyeOpen: 1, smile: 0.6, mouthOpen: 0, brow: 0, browAmount: 0, blush: 0.25, lookY: 0 },
  flapHz: 9, flapAmp: 16, wingLift: 0,
  bob: 6, bobHz: 0.55,
  lantern: 1, pulseAmt: 0.15, pulseHz: 0.6,
  alarm: 0, antenna: 0, tilt: 0, wiggle: 0,
};

const mood = (label: string, patch: Partial<Omit<MoodSpec, "face">> & { face?: MoodSpec["face"] }): MoodSpec => ({
  ...base, ...patch, label, face: { ...base.face, ...(patch.face ?? {}) },
});

export const MOODS = {
  idle: mood("Idle", {}),
  happy: mood("Happy", { face: { smile: 1, blush: 0.55 }, bob: 9, bobHz: 0.9, wiggle: 4, lantern: 1.15 }),
  excited: mood("Excited", { face: { smile: 1, mouthOpen: 0.45, blush: 0.7 }, flapHz: 16, flapAmp: 24, bob: 14, bobHz: 1.6, lantern: 1.3, pulseHz: 2, pulseAmt: 0.25, wiggle: 7 }),
  curious: mood("Curious", { face: { smile: 0.2, mouthOpen: 0.12, brow: 0.4, browAmount: 0.7, lookY: -0.3 }, tilt: 12, antenna: -10, flapHz: 7 }),
  thinking: mood("Thinking", { face: { smile: 0, eyeOpen: 0.85, brow: 0.2, browAmount: 0.6, lookY: -0.8 }, tilt: -8, flapHz: 5, flapAmp: 10, pulseHz: 1.4, pulseAmt: 0.3 }),
  alert: mood("Fire alert", { face: { smile: -0.4, mouthOpen: 0.6, brow: -0.8, browAmount: 1, blush: 0 }, flapHz: 18, flapAmp: 22, wingLift: -6, bob: 3, bobHz: 2.4, lantern: 1.4, pulseAmt: 0.45, pulseHz: 3, alarm: 1, antenna: -14, wiggle: 2 }),
  worried: mood("Worried", { face: { smile: -0.5, brow: 0.9, browAmount: 1, blush: 0.1, lookY: 0.2 }, flapHz: 12, flapAmp: 12, wingLift: 6, bob: 4, bobHz: 1.1, lantern: 0.8, antenna: 12, alarm: 0.3 }),
  sleepy: mood("Sleepy", { face: { eyeOpen: 0.12, smile: 0.25, blush: 0.4, lookY: 0.4 }, flapHz: 3, flapAmp: 8, wingLift: 12, bob: 10, bobHz: 0.25, lantern: 0.45, pulseAmt: 0.25, pulseHz: 0.25, antenna: 20, tilt: -10 }),
  sad: mood("Sad", { face: { smile: -0.8, eyeOpen: 0.75, brow: 1, browAmount: 0.9, blush: 0, lookY: 0.5 }, flapHz: 5, flapAmp: 8, wingLift: 14, bob: 3, bobHz: 0.35, lantern: 0.55, antenna: 26 }),
} satisfies Record<string, MoodSpec>;

export type MoodName = keyof typeof MOODS;
export const MOOD_NAMES = Object.keys(MOODS) as MoodName[];
