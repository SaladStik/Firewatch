/**
 * Agency-reported wildfires: the national fire list Natural Resources Canada compiles from every
 * provincial/territorial agency and Parks Canada (it feeds CIFFC's National Fires List).
 * https://api.cwfif.nrcan.gc.ca/reported-fire-stats/fire-list (public, no key, CORS enabled).
 *
 * This is the source of truth for "active fires". Satellite hotspots (cwfis.ts) are unconfirmed
 * heat detections: many are farm or controlled burns.
 */
const API = "https://api.cwfif.nrcan.gc.ca/reported-fire-stats/fire-list";

export type StageOfControl = "out_of_control" | "being_held" | "under_control";
export const STAGES: StageOfControl[] = ["out_of_control", "being_held", "under_control"];
export const STAGE_LABEL: Record<StageOfControl, string> = {
  out_of_control: "out of control", being_held: "being held", under_control: "under control",
};

export interface ReportedFire {
  /** National id, e.g. "2026_BC_K71234". */
  id: string;
  /** The agency's own fire number, e.g. "K71234". */
  name: string;
  /** Upper-case agency code (AB, BC, SK, … PC = Parks Canada). */
  agency: string;
  stage: StageOfControl;
  lat: number;
  lng: number;
  /** Hectares. */
  sizeHa: number;
  cause: string;
  /** full_response | modified_response | monitored_response. */
  response: string;
  /** ISO time of the last stage change. */
  statusDate: string;
  /** Workspace index of the region it falls in. */
  region?: number;
}

interface Item {
  national_fire_id: string; agency_fire_id: string; agency_code: string; fire_year: number;
  stage_of_control: string; status_date: string; fire_size: number; national_fire_cause: string;
  response_type: string; fire_was_prescribed: number; latitude: number; longitude: number;
}

/** Map an API item to a ReportedFire, or null for prescribed burns, stale records and bad rows. */
export function toReportedFire(it: Item, year: number): ReportedFire | null {
  const stage = it.stage_of_control as StageOfControl;
  // Some old fires linger "active" for years (e.g. 2020 monitored fires): keep this season only.
  if (!STAGES.includes(stage) || it.fire_year !== year || it.fire_was_prescribed === 1) return null;
  if (!Number.isFinite(it.latitude) || !Number.isFinite(it.longitude)) return null;
  return {
    id: it.national_fire_id, name: it.agency_fire_id, agency: it.agency_code.toUpperCase(), stage,
    lat: it.latitude, lng: it.longitude, sizeHa: Math.max(0, Number(it.fire_size) || 0),
    cause: it.national_fire_cause ?? "", response: it.response_type ?? "", statusDate: it.status_date ?? "",
  };
}

/**
 * Every non-extinguished fire this season for the given agencies (Parks Canada always included,
 * callers keep the ones inside their regions).
 */
export async function fetchReportedFires(agencies: string[], signal?: AbortSignal): Promise<ReportedFire[]> {
  const keep = new Set([...agencies.map((a) => a.toUpperCase()), "PC"]);
  const year = new Date().getFullYear();
  const out: ReportedFire[] = [];
  await Promise.all(STAGES.map(async (stage) => {
    for (let page = 1, pages = 1; page <= pages && page <= 10; page++) {
      const p = new URLSearchParams({ stage_of_control: stage, size: "200", page: String(page) });
      const res = await fetch(`${API}?${p}`, { signal });
      if (!res.ok) throw new Error(`Reported fires ${res.status}`);
      const json = (await res.json()) as { items?: Item[]; pages?: number };
      pages = json.pages ?? 1;
      for (const it of json.items ?? []) {
        const f = keep.has(String(it.agency_code).toUpperCase()) ? toReportedFire(it, year) : null;
        if (f) out.push(f);
      }
    }
  }));
  return out;
}
