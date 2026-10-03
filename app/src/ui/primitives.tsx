import { ChevronDown, ChevronUp } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";

/** Remembered per panel (by its tour id or title) so a minimized panel stays minimized. */
const collapsedKey = (id: string) => `firewatch.panel.${id}.collapsed`;
function readCollapsed(id: string) {
  try { return localStorage.getItem(collapsedKey(id)) === "1"; } catch { return false; }
}

/** Dock menus rest closed. A missing key is closed; "0" is the one menu left open. */
function readDockCollapsed(id: string) {
  try {
    const v = localStorage.getItem(collapsedKey(id));
    if (v === null) return true;
    return v === "1";
  } catch { return true; }
}

const DOCK_IDS = ["layers", "legend", "explore"] as const;

function readOpenDock(): string | null {
  let open: string | null = null;
  for (const id of DOCK_IDS) {
    let stored: string | null = null;
    try { stored = localStorage.getItem(collapsedKey(id)); } catch { stored = null; }
    if (stored !== "0") continue;
    if (open === null) open = id;
    else {
      try { localStorage.setItem(collapsedKey(id), "1"); } catch { /* storage unavailable */ }
    }
  }
  return open;
}

function writeOpenDock(openId: string | null) {
  for (const id of DOCK_IDS) {
    try { localStorage.setItem(collapsedKey(id), openId === id ? "0" : "1"); } catch { /* storage unavailable */ }
  }
}

const DockMenuContext = createContext<{
  openId: string | null;
  setOpenId: (id: string | null) => void;
} | null>(null);

/** One open menu among the bottom-bar tools. Children stay direct flex items. */
export function DockBar({ children }: { children: ReactNode }) {
  const [openId, setOpen] = useState(readOpenDock);
  const setOpenId = (id: string | null) => {
    setOpen(id);
    writeOpenDock(id);
  };
  return <DockMenuContext.Provider value={{ openId, setOpenId }}>{children}</DockMenuContext.Provider>;
}

/**
 * A HUD panel with a title bar. Panels with a title can be minimized to just that bar (click the
 * title or the chevron); the state is remembered across reloads.
 */
export function Panel({
  children,
  className = "",
  title,
  right,
  tour,
  collapsible = true,
  dock = false,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  right?: ReactNode;
  tour?: string;
  collapsible?: boolean;
  /** A segment of the bottom bar. The body opens upward instead of its own card. */
  dock?: boolean;
}) {
  const id = tour ?? title ?? "";
  const canCollapse = collapsible && !!title && !!id;
  const menu = useContext(DockMenuContext);
  const [collapsed, setCollapsed] = useState(() => {
    if (!canCollapse) return false;
    return dock ? readDockCollapsed(id) : readCollapsed(id);
  });
  const isCollapsed = dock && menu ? menu.openId !== id : collapsed;
  const toggle = () => {
    if (dock && menu) {
      menu.setOpenId(menu.openId === id ? null : id);
      return;
    }
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(collapsedKey(id), next ? "1" : "0"); } catch { /* storage unavailable */ }
  };
  if (dock && title) {
    return (
      <div className="relative flex items-center self-stretch border-r border-line px-1" data-tour={tour}>
        {!isCollapsed && (
          <div
            className={`panel z-20 overflow-auto ${className}`}
            style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, maxHeight: "min(70vh, 32rem)" }}
          >
            {children}
          </div>
        )}
        <button
          type="button"
          onClick={toggle}
          className="label-xs h-9 px-1.5"
          aria-expanded={!isCollapsed}
          title={isCollapsed ? `Show ${title}` : `Hide ${title}`}
        >
          {title}
        </button>
        {right}
        <button type="button" onClick={toggle} className="px-0.5 text-ink-mute transition hover:text-phos" aria-label={isCollapsed ? `Show ${title}` : `Hide ${title}`}>
          {isCollapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>
    );
  }
  return (
    <section className={`panel pointer-events-auto ${collapsed ? "" : className}`} data-tour={tour}>
      {title && (
        <header className={`flex items-center justify-between gap-2 px-3 py-2 ${collapsed ? "" : "border-b border-line"}`}>
          <button
            type="button"
            onClick={canCollapse ? toggle : undefined}
            className={`flex min-w-0 items-center gap-2 text-left ${canCollapse ? "cursor-pointer" : "cursor-default"}`}
            aria-expanded={canCollapse ? !collapsed : undefined}
            title={canCollapse ? (collapsed ? `Show ${title}` : `Minimize ${title}`) : undefined}
          >
            <span className="label-xs truncate">{title}</span>
          </button>
          <span className="flex shrink-0 items-center gap-1">
            {right}
            {canCollapse && (
              <button type="button" onClick={toggle} className="text-ink-mute transition hover:text-phos" aria-label={collapsed ? `Show ${title}` : `Minimize ${title}`}>
                {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
              </button>
            )}
          </span>
        </header>
      )}
      {!collapsed && children}
    </section>
  );
}

/** The FIRE//WATCH mark — the same hexagon + flame as the favicon (public/favicon.svg). */
export function LogoMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label="FIRE//WATCH" role="img">
      <path d="M12 2 20.66 7v10L12 22 3.34 17V7z" fill="none" stroke="#2eea7c" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12 8c1.8 2 2.6 3.4 2.6 4.8a2.6 2.6 0 0 1-5.2 0c0-.9.4-1.8 1.2-2.6.1 1 .6 1.5 1.1 1.6-.4-1.3-.2-2.5.3-3.8z" fill="#ff6a1a" />
    </svg>
  );
}

export function Swatch({ color, fill }: { color: string; fill?: string }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px] border"
      style={{ borderColor: color, background: fill ?? color }}
      aria-hidden
    />
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
        className="flex h-3.5 w-3.5 items-center justify-center rounded-[2px] border"
        style={{ borderColor: on ? (color ?? "var(--color-phos)") : "var(--color-ink-mute)" }}
      >
        {on && <span className="h-1.5 w-1.5" style={{ background: color ?? "var(--color-phos)" }} />}
      </span>
      <span className={on ? "text-ink" : "text-ink-mute"}>{label}</span>
    </button>
  );
}

export function SegBar({ value, segments = 20, color = "var(--color-phos)" }: { value: number; segments?: number; color?: string }) {
  const lit = Math.round(Math.max(0, Math.min(1, value)) * segments);
  return (
    <div className="flex h-1.5 overflow-hidden rounded-[2px] border border-line">
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className="h-full flex-1"
          style={{ background: i < lit ? color : "transparent" }}
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
      className={`flex h-9 w-9 items-center justify-center border bg-panel transition-all hover:border-phos hover:text-phos-glow ${active ? "border-phos text-phos-glow" : "border-line text-ink-dim"}`}
    >
      {children}
    </button>
  );
}
