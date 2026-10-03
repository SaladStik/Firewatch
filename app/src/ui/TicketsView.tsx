/**
 * Calgary 311 tickets: every ticket in the sample (open, closed, duplicates, and the blizzard's
 * calls when that disruption is on), with its priority and where today's plan puts it.
 * Filter, sort, click a row to fly to it; mark a ticket urgent or hold it and the day replans.
 */
import { ArrowDown, ArrowUp, Search, Snowflake, X } from "lucide-react";
import { useMemo, useState } from "react";
import { crewColor } from "../dispatch/colors";
import { flyTo, openTickets, setOverride } from "../dispatch/controller";
import { daysWaiting, priority, typeOf, type Ticket, type Unit } from "../dispatch/ops311";
import { dispatch } from "../dispatch/store";
import { useStore } from "../state/store";

type SortKey = "priority" | "date" | "service" | "community" | "status" | "crew";
type Plan = "all" | "today" | "waiting" | "tomorrow";

const title = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

function Th({ k, sort, onSort, children, className = "" }: { k: SortKey; sort: { key: SortKey; desc: boolean }; onSort: (k: SortKey) => void; children: string; className?: string }) {
  return (
    <th className={`cursor-pointer select-none px-2 py-1.5 text-left font-normal hover:text-ink ${className}`} onClick={() => onSort(k)}>
      <span className="inline-flex items-center gap-0.5">{children}{sort.key === k && (sort.desc ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}</span>
    </th>
  );
}

function Chip<T extends string>({ value, current, set, children }: { value: T; current: T; set: (v: T) => void; children: string }) {
  return (
    <button type="button" onClick={() => set(value)} className={`border px-2 py-0.5 text-[11px] transition ${current === value ? "border-phos text-ink" : "border-line text-ink-mute hover:text-ink"}`}>{children}</button>
  );
}

export function TicketsView() {
  const d = useStore(dispatch, (s) => s);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"open" | "all" | "closed">("open");
  const [unit, setUnit] = useState<Unit | "all">("all");
  const [plan, setPlan] = useState<Plan>("all");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "priority", desc: true });
  const p = d.plan311, load = d.load311;
  const noon = d.at === "noon" && p?.noon ? p.noon : null;

  const rows = useMemo(() => {
    if (!load || !p) return [];
    const where = new Map<string, { crew: string; stop: number }>();
    (noon ?? p.morning).routes.forEach((list, crew) => list.forEach((t, i) => where.set(t.id, { crew, stop: i + 1 })));
    const dropped = new Set(p.dropped.map((x) => x.ticket.id));
    const all: Ticket[] = [...load.all, ...(noon ? p.added : [])];
    return all.map((t) => {
      const open = !/closed|duplicate/i.test(t.status);
      return {
        t, open,
        type: typeOf(t.service),
        pr: open ? priority(t, p.today) : 0,
        age: daysWaiting(t, p.today),
        at: where.get(t.id) ?? null,
        tomorrow: noon ? dropped.has(t.id) : false,
        override: d.overrides[t.id] ?? null,
      };
    });
  }, [load, p, noon, d.overrides]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = rows.filter((r) =>
      (status === "all" || (status === "open" ? r.open : !r.open)) &&
      (unit === "all" || r.type.unit === unit) &&
      (plan === "all" || (plan === "today" ? !!r.at : plan === "tomorrow" ? r.tomorrow : r.open && !r.at)) &&
      (!needle || `${r.t.id} ${r.t.service} ${r.t.community} ${r.type.label}`.toLowerCase().includes(needle)));
    const k = sort.key, s = sort.desc ? -1 : 1;
    const val = (r: (typeof rows)[number]): string | number =>
      k === "priority" ? r.pr : k === "date" ? r.t.date : k === "service" ? r.type.label : k === "community" ? r.t.community : k === "status" ? r.t.status : r.at ? `${r.at.crew}${String(r.at.stop).padStart(2, "0")}` : "~";
    return list.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * s || b.pr - a.pr; });
  }, [rows, q, status, unit, plan, sort]);

  const counts = useMemo(() => ({
    open: rows.filter((r) => r.open).length,
    today: rows.filter((r) => r.at).length,
    safety: rows.filter((r) => r.open && r.type.safety >= 3).length,
    held: Object.values(d.overrides).filter((o) => o === "hold").length,
    urgent: Object.values(d.overrides).filter((o) => o === "urgent").length,
  }), [rows, d.overrides]);

  const onSort = (k: SortKey) => setSort((s) => ({ key: k, desc: s.key === k ? !s.desc : k === "priority" }));

  return (
    <aside className="flex h-full flex-col border-l border-line bg-[var(--color-panel)] shadow-[-8px_0_24px_rgb(16_24_32/0.12)] backdrop-blur-md" data-tour="tickets">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <div className="label-xs">Calgary 311 · tickets</div>
          <p className="mt-0.5 text-[12px] text-ink-dim">
            {counts.open} open · {counts.today} on today's {noon ? "noon" : "8 a.m."} plan · {counts.safety} safety · {counts.urgent} urgent · {counts.held} held{p ? ` · planning ${p.today}` : ""}
          </p>
        </div>
        <button type="button" onClick={() => openTickets(false)} aria-label="Close tickets" className="text-ink-mute transition hover:text-phos"><X size={16} /></button>
      </header>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2">
        <label className="flex min-w-[12rem] flex-1 items-center gap-1.5 border border-line px-2 py-1">
          <Search size={12} className="text-ink-mute" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search id, type, community…" aria-label="Search tickets" className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-mute" />
        </label>
        <Chip value="open" current={status} set={setStatus}>Open</Chip>
        <Chip value="closed" current={status} set={setStatus}>Closed</Chip>
        <Chip value="all" current={status} set={setStatus}>All</Chip>
        <span className="mx-1 h-4 w-px bg-[var(--color-line)]" />
        <Chip value="all" current={unit} set={setUnit}>Any unit</Chip>
        <Chip value="Roads" current={unit} set={setUnit}>Roads</Chip>
        <Chip value="WRS" current={unit} set={setUnit}>Waste</Chip>
        <Chip value="Other" current={unit} set={setUnit}>Other</Chip>
        <span className="mx-1 h-4 w-px bg-[var(--color-line)]" />
        <Chip value="all" current={plan} set={setPlan}>Any</Chip>
        <Chip value="today" current={plan} set={setPlan}>Today</Chip>
        <Chip value="waiting" current={plan} set={setPlan}>Waiting</Chip>
        {noon && <Chip value="tomorrow" current={plan} set={setPlan}>Bumped</Chip>}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-auto">
        {!p && <p className="p-4 text-[12px] text-ink-mute">Loading tickets…</p>}
        {p && (
          <table className="w-full text-[11.5px]">
            <thead className="sticky top-0 bg-[var(--color-panel)] text-[10px] uppercase tracking-[0.06em] text-ink-mute">
              <tr>
                <Th sort={sort} onSort={onSort} k="priority" className="text-right">Pri</Th>
                <th className="px-2 py-1.5 text-left font-normal">Ticket</th>
                <Th sort={sort} onSort={onSort} k="date">Received</Th>
                <Th sort={sort} onSort={onSort} k="service">Type</Th>
                <Th sort={sort} onSort={onSort} k="community">Community</Th>
                <Th sort={sort} onSort={onSort} k="status">Status</Th>
                <Th sort={sort} onSort={onSort} k="crew">Crew</Th>
                <th className="px-2 py-1.5 text-right font-normal">Dispatcher</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const crewIdx = r.at ? p.crews.findIndex((c) => c.id === r.at!.crew) : -1;
                return (
                  <tr key={r.t.id} onClick={() => flyTo(r.t.lat, r.t.lng, 2.5)} className={`cursor-pointer border-t border-line/60 hover:bg-[color-mix(in_srgb,var(--color-phos)_7%,transparent)] ${r.open ? "text-ink" : "text-ink-mute"}`}>
                    <td className="px-2 py-1 text-right tabular-nums">{r.open ? r.pr : "–"}</td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-[10.5px]">{r.t.simulated && <Snowflake size={10} className="mr-1 inline text-[#6cc4ff]" />}{r.t.id}</td>
                    <td className="whitespace-nowrap px-2 py-1 tabular-nums text-ink-dim">{r.t.date}{r.open ? <span className="text-ink-mute"> · {r.age}d</span> : null}</td>
                    <td className="px-2 py-1"><span className={r.type.safety >= 4 ? "text-risk-high" : r.type.safety >= 3 ? "text-risk-elev" : ""}>{r.type.label}</span><span className="text-ink-mute"> · {r.type.unit === "WRS" ? "Waste" : r.type.unit}</span></td>
                    <td className="px-2 py-1">{title(r.t.community)}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-ink-dim">{r.t.status}</td>
                    <td className="whitespace-nowrap px-2 py-1">
                      {r.at ? <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ background: crewColor(crewIdx) }} />{r.at.crew} · stop {r.at.stop}</span>
                        : r.tomorrow ? <span className="text-risk-high">bumped to tomorrow</span>
                          : r.open ? <span className="text-ink-mute">waiting</span> : ""}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-right" onClick={(e) => e.stopPropagation()}>
                      {r.open && (
                        <span className="inline-flex gap-1">
                          <button type="button" onClick={() => setOverride(r.t.id, r.override === "urgent" ? null : "urgent")} className={`border px-1.5 text-[10px] ${r.override === "urgent" ? "border-risk-high text-risk-high" : "border-line text-ink-mute hover:text-ink"}`}>Urgent</button>
                          <button type="button" onClick={() => setOverride(r.t.id, r.override === "hold" ? null : "hold")} className={`border px-1.5 text-[10px] ${r.override === "hold" ? "border-phos text-phos" : "border-line text-ink-mute hover:text-ink"}`}>Hold</button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {p && !shown.length && <p className="p-4 text-[12px] text-ink-mute">No tickets match.</p>}
      </div>
    </aside>
  );
}
