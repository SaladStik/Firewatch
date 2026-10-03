/**
 * Click Firefly to open the chat. The mascot stage is click-through, so this invisible button
 * follows him while he rests at his spot (not while he's out showing something).
 */
import { useEffect, useRef } from "react";
import { getStage } from "../mascot/firefly/script";
import { fireflyAway } from "./mascot";

export function FireflyHotspot({ enabled, onOpen }: { enabled: boolean; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!enabled) { el.style.display = "none"; return; }
    const st = getStage();
    let raf = 0;
    const tick = () => {
      const show = st.get().visible && !st.playing && !fireflyAway();
      el.style.display = show ? "block" : "none";
      if (show) {
        const size = st.sizePx(), c = st.centrePx(), box = size * 0.7;
        Object.assign(el.style, { left: `${c.x - box / 2}px`, top: `${c.y - box / 2}px`, width: `${box}px`, height: `${box}px` });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);

  const open = () => {
    getStage().controller.play("hop");
    onOpen();
  };

  return (
    <button
      ref={ref}
      type="button"
      onClick={open}
      aria-label="Open the Firefly chat"
      title="Ask Firefly"
      className="pointer-events-auto fixed z-40 hidden cursor-pointer rounded-full bg-transparent"
    />
  );
}
