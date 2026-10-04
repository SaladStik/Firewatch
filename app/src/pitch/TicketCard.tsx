/**
 * The 311 call as a card: what came in, then why it goes first (each part of its priority filling
 * in, the total counting up), then which crew has it.
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { pitch } from "./store";

const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Counts from 0 to `to` over `ms` once `run` turns true. */
function useCount(to: number, run: boolean, ms = 1400) {
  const [v, setV] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    if (!run) { raf.current = requestAnimationFrame(() => setV(0)); return () => cancelAnimationFrame(raf.current); }
    const t0 = performance.now();
    const tick = () => {
      const u = Math.min(1, (performance.now() - t0) / ms);
      setV(Math.round(to * (1 - Math.pow(1 - u, 3))));
      if (u < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [to, run, ms]);
  return v;
}

export function TicketCard() {
  const st = useStore(pitch, (s) => s.story311);
  const phase = useStore(pitch, (s) => s.call);
  const shown = !!st && phase >= 1 && phase <= 3;
  const scoring = phase >= 2;
  const total = useCount(st?.parts.total ?? 0, scoring && shown);
  if (!st) return null;
  const p = st.parts;
  const rows = [
    { k: "Safety", v: p.safety, note: `${cap(st.label)}` },
    { k: "Weather & place", v: p.impact, note: p.why.find((w) => /°C|snow|rain|freez|school|hospital|crossing|hill|senior/i.test(w)) ?? "Today's conditions here" },
    { k: "Waiting", v: p.waiting, note: `${st.daysWaiting} days` },
    { k: "More reports", v: p.nearby + p.history, note: st.reports > 1 ? `Reported ${st.reports} times` : "Nearby and past reports" },
  ].filter((r) => r.v > 0);
  const max = Math.max(...rows.map((r) => r.v), 1);
  return (
    <div className="pitch-card pointer-events-none absolute right-8 top-1/2 z-20 w-[min(26rem,34vw)]" data-shown={shown} style={{ transform: `translateY(-50%) translateX(${shown ? 0 : 24}px)` }}>
      <div className="rounded-xl border border-white/10 bg-[rgb(9_15_13/0.86)] p-5 shadow-[0_24px_60px_-20px_rgb(0_0_0/0.8)] backdrop-blur-md">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-[#8fb3a2]">
          <span>311 · {st.source === "live" ? "Live Open Calgary queue" : "Case sample"}</span>
          <span className="tabular-nums">{st.ticket.id}</span>
        </div>
        <div className="mt-3 text-[26px] font-semibold leading-tight text-white">{cap(st.label)}</div>
        <div className="mt-1 text-[15px] text-[#b9cfc4]">{titleCase(st.ticket.community)} · {st.daysWaiting} days open{st.reports > 1 ? ` · ${st.reports} reports` : ""}</div>

        <div className="pitch-collapse mt-4" data-open={scoring}>
          <div className="space-y-2.5">
            {rows.map((r, i) => (
              <div key={r.k}>
                <div className="flex items-baseline justify-between text-[13px]">
                  <span className="text-[#dfeee6]">{r.k}</span>
                  <span className="text-[12px] text-[#8fb3a2]">{r.note}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className="pitch-bar h-full rounded-full bg-gradient-to-r from-[#ff9a3d] to-[#ff5a36]" style={{ width: scoring ? `${(r.v / max) * 100}%` : "0%", transitionDelay: `${150 + i * 140}ms` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-end justify-between border-t border-white/10 pt-3">
            <span className="text-[12px] uppercase tracking-[0.16em] text-[#8fb3a2]">Priority</span>
            <span className="text-[40px] font-semibold leading-none tabular-nums text-white">{total}</span>
          </div>
          <div className="mt-1 text-right text-[12px] text-[#ffb08f]">#{st.rank} of {st.open.toLocaleString("en-CA")} open tickets</div>
        </div>

        <div className="pitch-collapse" data-open={phase >= 3}>
          <div className="mt-4 flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2.5">
            <span className="h-3 w-3 rounded-full" style={{ background: st.crewColor, boxShadow: `0 0 10px ${st.crewColor}` }} />
            <span className="text-[14px] text-white">Crew {st.crew}</span>
            <span className="ml-auto text-[13px] tabular-nums text-[#b9cfc4]">{st.route.km.toFixed(1)} km · {Math.round(st.route.minutes)} min</span>
          </div>
        </div>
      </div>
    </div>
  );
}
