import type { ReactNode } from "react";

export function Panel({ children, className = "", title, right }: { children: ReactNode; className?: string; title?: string; right?: ReactNode }) {
  return (
    <section className={`panel pointer-events-auto ${className}`}>
      {title && (
        <header className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="label-xs">{title}</span>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function HexIcon({ size = 16, color = "currentColor", fill = "none", className = "" }: { size?: number; color?: string; fill?: string; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M12 2 20.66 7v10L12 22 3.34 17V7z" fill={fill} stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function Toggle({ on, onChange, label, color, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; color?: string; hint?: string }) {
  return (
    <button
      onClick={() => onChange(!on)}
      title={hint}
      className="group flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[11px] tracking-wide transition-colors hover:bg-phos/5"
    >
      <span
        className="flex h-3.5 w-3.5 items-center justify-center border transition-all"
        style={{ borderColor: on ? (color ?? "var(--color-phos)") : "var(--color-ink-mute)", boxShadow: on ? `0 0 8px ${color ?? "var(--color-phos)"}` : "none" }}
      >
        {on && <span className="h-1.5 w-1.5" style={{ background: color ?? "var(--color-phos)" }} />}
      </span>
      <span className={on ? "text-ink" : "text-ink-mute"}>{label}</span>
    </button>
  );
}

/** Segmented progress bar (reads more "instrument" than a smooth bar). */
export function SegBar({ value, segments = 20, color = "var(--color-phos)" }: { value: number; segments?: number; color?: string }) {
  const lit = Math.round(Math.max(0, Math.min(1, value)) * segments);
  return (
    <div className="flex gap-[2px]">
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className="h-1.5 flex-1 transition-all duration-500"
          style={{
            background: i < lit ? color : "transparent",
            border: `1px solid ${i < lit ? color : "var(--color-line)"}`,
            boxShadow: i < lit ? `0 0 6px ${color}` : "none",
          }}
        />
      ))}
    </div>
  );
}

export function KV({ k, v, accent }: { k: string; v: ReactNode; accent?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px] text-[11px]">
      <span className="text-ink-mute">{k}</span>
      <span className="text-right tabular-nums" style={{ color: accent ?? "var(--color-ink)" }}>{v}</span>
    </div>
  );
}

export function IconButton({ children, onClick, title, active }: { children: ReactNode; onClick: () => void; title: string; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`flex h-9 w-9 items-center justify-center border transition-all hover:border-phos hover:text-phos-glow ${active ? "border-phos text-phos-glow" : "border-line text-ink-dim"}`}
      style={{ background: "var(--color-panel)" }}
    >
      {children}
    </button>
  );
}
