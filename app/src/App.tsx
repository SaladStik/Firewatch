import { useEffect, useRef, useState } from "react";
import { Engine } from "./engine";
import { app } from "./state/app";
import { FireFeed } from "./ui/FireFeed";
import { Brand, InstrumentDataButton, LodReadout, ThemeToggle } from "./ui/Hud";
import { Explore } from "./ui/Explore";
import { InstrumentData } from "./ui/InstrumentData";
import { LayerDock, Legend } from "./ui/Layers";
import { BootScreen, HoverTip, NavControls } from "./ui/Overlays";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { SectorPanel } from "./ui/SectorPanel";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [screen, setScreen] = useState<"map" | "instruments">("map");

  useEffect(() => {
    const e = new Engine();
    if (import.meta.env.DEV) Object.assign(window, { engine: e, app }); // debug handles
    void e.boot(canvasRef.current!, labelsRef.current!).then(() => setEngine(e));
    return () => e.dispose();
  }, []);

  return (
    <main className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none outline-none" />
      <div className="screen-fx" />
      {/* Labels sit above the scanline layer so text stays crisp. */}
      <div ref={labelsRef} className="pointer-events-none absolute inset-0 z-[1] overflow-hidden" />

      {/* HUD layout — every panel is pointer-events-auto; the frame itself is click-through. */}
      <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-4">
        <div className="flex items-start justify-between gap-4">
          <Brand />
          <LodReadout />
          <div className="flex items-start gap-2">
            <InstrumentDataButton onClick={() => setScreen("instruments")} />
            <ThemeToggle engine={engine} />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-between gap-4 py-4">
          <div className="hidden max-h-full min-h-0 gap-2 md:flex">
            <div className="flex flex-col gap-2">
              <ErrorBoundary name="LayerDock"><LayerDock engine={engine} /></ErrorBoundary>
              <Legend />
            </div>
            <div className="flex max-h-full min-h-0 flex-col self-start">
              <ErrorBoundary name="Explore"><Explore engine={engine} /></ErrorBoundary>
            </div>
          </div>
          <div className="scroll-thin ml-auto max-h-full self-start overflow-y-auto">
            <ErrorBoundary name="SectorPanel"><SectorPanel engine={engine} /></ErrorBoundary>
          </div>
        </div>

        <div className="flex items-end justify-between gap-4">
          <div className="w-9" />
          <ErrorBoundary name="FireFeed"><FireFeed engine={engine} /></ErrorBoundary>
          <NavControls engine={engine} />
        </div>
      </div>
      <HoverTip />
      <BootScreen />
      {screen === "instruments" && <InstrumentData onBack={() => setScreen("map")} />}
    </main>
  );
}
