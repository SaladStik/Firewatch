import { ConversationProvider } from "@elevenlabs/react";
import { useEffect, useRef, useState } from "react";
import { Engine } from "./engine";
import { FireflyDock } from "./firefly/FireflyDock";
import { FireflyHotspot } from "./firefly/FireflyHotspot";
import { mountLodTuner } from "./dev/LodTuner";
import { app } from "./state/app";
import { StatusDock } from "./ui/StatusDock";
import { AppBar, BarButton, LodReadout } from "./ui/Hud";
import { closeDispatch, openDispatch } from "./dispatch/controller";
import { dispatch } from "./dispatch/store";
import { useStore } from "./state/store";
import { DispatchPanel } from "./ui/DispatchPanel";
import { DispatchPins } from "./ui/DispatchPins";
import { RouteOverlay } from "./ui/RouteOverlay";
import { AircraftLayer } from "./ui/AircraftLayer";
import { TicketsView } from "./ui/TicketsView";
import { Explore } from "./ui/Explore";
import { InstrumentData } from "./ui/InstrumentData";
import { LayerDock, Legend } from "./ui/Layers";
import { BootScreen, CompassRose, HoverTip, NavControls } from "./ui/Overlays";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { SectorPanel } from "./ui/SectorPanel";
import { ValuesAtRisk } from "./ui/ValuesAtRisk";

function MapMenu({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
        className={`grid h-9 w-9 shrink-0 place-items-center transition ${open ? "text-phos" : "text-ink-dim hover:text-phos"}`}
      aria-label="Layers, legend, and explore"
      aria-expanded={open}
      title="Layers, legend, and explore"
      onClick={onToggle}
    >
      <span className="flex w-3.5 flex-col gap-1" aria-hidden>
        <span className="block h-0.5 w-full bg-current" />
        <span className="block h-0.5 w-full bg-current" />
      </span>
    </button>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [screen, setScreen] = useState<"map" | "instruments">("map");
  const [askOpen, setAskOpen] = useState(false);
  const [mapMenuOpen, setMapMenuOpen] = useState(false);
  const dispatchOpen = useStore(dispatch, (s) => s.open);
  const ticketsOpen = useStore(dispatch, (s) => s.ticketsOpen);

  useEffect(() => {
    const e = new Engine();
    if (import.meta.env.DEV) Object.assign(window, { engine: e, app, dispatch }); // debug handles
    void e.boot(canvasRef.current!, labelsRef.current!).then(() => setEngine(e));
    mountLodTuner(() => (e.scene ? e : null)); // Ctrl+Shift+L (dev / ?fireflydev)
    return () => e.dispose();
  }, []);

  return (
    <ConversationProvider>
    <main className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none outline-none" />
      <div className="screen-fx" />
      {/* Labels sit above the scanline layer so text stays crisp. */}
      <div ref={labelsRef} className="pointer-events-none absolute inset-0 z-[1] overflow-hidden" />

      {/* HUD layout — every panel is pointer-events-auto; the frame itself is click-through. */}
      <div className="pointer-events-none absolute inset-0 z-10 flex flex-col">
        <AppBar
          engine={engine}
          screen={screen}
          onScreen={setScreen}
          center={<LodReadout engine={engine} />}
          extra={<BarButton active={dispatchOpen && screen === "map"} onClick={() => { if (screen !== "map") setScreen("map"); if (dispatchOpen && screen === "map") closeDispatch(); else openDispatch(); }}>Dispatch</BarButton>}
          askOpen={askOpen && screen === "map"}
          onAsk={() => {
            if (screen !== "map") {
              setScreen("map");
              setAskOpen(true);
              return;
            }
            setAskOpen((open) => !open);
          }}
        />
        <div className="flex min-h-0 flex-1">
          <div className={askOpen && screen === "map" ? "pointer-events-auto h-full w-[min(24rem,88vw)] shrink-0" : "hidden"}>
            <ErrorBoundary name="Ask"><FireflyDock engine={engine} open={askOpen && screen === "map"} onClose={() => setAskOpen(false)} /></ErrorBoundary>
          </div>
          {dispatchOpen && screen === "map" && (
            <div className="pointer-events-auto h-full w-[min(26rem,90vw)] shrink-0">
              <ErrorBoundary name="Dispatch"><DispatchPanel engine={engine} /></ErrorBoundary>
            </div>
          )}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-between p-4">
          <div className="flex min-h-0 flex-1 items-start justify-end gap-4 py-3">
            <div className="scroll-thin ml-auto max-h-full self-start overflow-y-auto">
              <ErrorBoundary name="SectorPanel"><SectorPanel engine={engine} /></ErrorBoundary>
              <ErrorBoundary name="ValuesAtRisk"><ValuesAtRisk engine={engine} /></ErrorBoundary>
            </div>
          </div>
          <div className="flex w-full min-w-0 flex-col items-end gap-1">
            <div className="flex items-stretch gap-1">
              <div className="relative flex">
                {mapMenuOpen && (
                  <div
                    className="pointer-events-auto flex items-end gap-2"
                    style={{ position: "absolute", right: "calc(100% + 8px)", bottom: 0 }}
                  >
                    <ErrorBoundary name="LayerDock"><LayerDock engine={engine} /></ErrorBoundary>
                    <ErrorBoundary name="Legend"><Legend /></ErrorBoundary>
                    <ErrorBoundary name="Explore"><Explore engine={engine} /></ErrorBoundary>
                  </div>
                )}
                <CompassRose engine={engine} fill />
              </div>
              <div className="panel pointer-events-auto flex flex-col">
                <MapMenu open={mapMenuOpen} onToggle={() => setMapMenuOpen((open) => !open)} />
                <NavControls engine={engine} bar />
              </div>
            </div>
            <div className="panel pointer-events-auto w-full min-w-0">
              <ErrorBoundary name="StatusDock"><StatusDock engine={engine} embedded /></ErrorBoundary>
            </div>
          </div>
          </div>
          {ticketsOpen && screen === "map" && (
            <div className="pointer-events-auto h-full w-[min(56rem,62vw)] shrink-0">
              <ErrorBoundary name="Tickets"><TicketsView /></ErrorBoundary>
            </div>
          )}
        </div>
      </div>
      {screen === "map" && <RouteOverlay engine={engine} />}
      {screen === "map" && <AircraftLayer engine={engine} />}
      {screen === "map" && <DispatchPins engine={engine} />}
      <FireflyHotspot enabled={screen === "map" && !askOpen} onOpen={() => setAskOpen(true)} />
      <HoverTip />
      <BootScreen />
      {screen === "instruments" && <InstrumentData engine={engine} onBack={() => setScreen("map")} />}
    </main>
    </ConversationProvider>
  );
}
