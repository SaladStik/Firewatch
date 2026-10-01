/**
 * <FireflyAgent/> — the firefly as an on-screen character: positioned by the
 * controller's flight, with a speech bubble. Plus useFirefly() for React.
 */
import { useEffect, useRef, useState } from "react";
import { DEFAULT_CONFIG } from "./config";
import { FireflyController } from "./controller";
import { Firefly } from "./Firefly";
import type { MoodName } from "./moods";
import type { FireflyConfig, FireflyPose } from "./types";

/** Create (once) and run a controller; re-renders with each frame's pose. */
export function useFirefly(opts: { x?: number; y?: number; mood?: MoodName } = {}) {
  const ref = useRef<FireflyController | null>(null);
  if (!ref.current) ref.current = new FireflyController(opts);
  const ctl = ref.current;
  const [, setFrame] = useState(0);
  useEffect(() => {
    const off = ctl.subscribe(() => setFrame((f) => (f + 1) % 1e6));
    ctl.start();
    return () => { off(); ctl.stop(); };
  }, [ctl]);
  return ctl;
}

export function FireflyAgent({ controller, config = DEFAULT_CONFIG, size = 120 }: { controller: FireflyController; config?: FireflyConfig; size?: number }) {
  const pose: FireflyPose = controller.pose;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        transform: `translate(${pose.x - size / 2}px, ${pose.y - size / 2}px)`,
        width: size,
        pointerEvents: "none",
        willChange: "transform",
      }}
    >
      {controller.speech && <SpeechBubble text={controller.speech} />}
      <Firefly pose={pose} config={config} size={size} />
    </div>
  );
}

function SpeechBubble({ text }: { text: string }) {
  return (
    <div
      style={{
        position: "absolute",
        bottom: "92%",
        left: "60%",
        maxWidth: 220,
        width: "max-content",
        padding: "8px 11px",
        borderRadius: 12,
        borderBottomLeftRadius: 2,
        background: "rgba(8, 18, 28, 0.92)",
        border: "1px solid rgba(55, 227, 255, 0.55)",
        boxShadow: "0 0 18px -6px rgba(55, 227, 255, 0.8)",
        color: "#e8faff",
        font: "500 12px/1.4 'JetBrains Mono', ui-monospace, monospace",
      }}
    >
      {text}
    </div>
  );
}
