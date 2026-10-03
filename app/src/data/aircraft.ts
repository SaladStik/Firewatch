/**
 * Firefighting aircraft, live: every airborne aircraft of a firefighting type over western North
 * America, from adsb.lol's open ADS-B feed (community receivers; ODbL; no key). Picked by ICAO
 * type designator — skimmers (CL-415/215), Air Tractor Fire Bosses, and the big air tankers
 * (Electra, RJ85, Convair 580, MD-87, C-130, 737 Fireliner). Bird dogs and helicopters can't be
 * told apart from other traffic by type, so they're left out.
 *
 * adsb.lol doesn't allow calls from web pages, so this runs on the data server (/api/aircraft,
 * refreshed every 2 minutes); the website without a server shows no live aircraft.
 */

export type AirRole = "skimmer" | "airtanker" | "fireboss";

/** Firefighting types (ICAO designator) → role and a readable name. */
export const FIRE_TYPES: Record<string, { role: AirRole; name: string }> = {
  CL2T: { role: "skimmer", name: "CL-415 / CL-215T skimmer" },
  CL2P: { role: "skimmer", name: "CL-215 skimmer" },
  AT8T: { role: "fireboss", name: "Air Tractor 802 Fire Boss" },
  AT6T: { role: "fireboss", name: "Air Tractor 602" },
  L188: { role: "airtanker", name: "L-188 Electra air tanker" },
  RJ85: { role: "airtanker", name: "Avro RJ85 air tanker" },
  CVLT: { role: "airtanker", name: "Convair 580 air tanker" },
  MD87: { role: "airtanker", name: "MD-87 air tanker" },
  C130: { role: "airtanker", name: "C-130 air tanker" },
  B732: { role: "airtanker", name: "737 Fireliner" },
};

export interface LiveAircraft {
  hex: string;
  reg: string;
  callsign: string;
  type: string;
  role: AirRole;
  name: string;
  lat: number;
  lng: number;
  /** Feet (barometric), null on the ground. */
  altFt: number | null;
  /** Ground speed (knots) and track (degrees true). */
  gsKt: number;
  track: number;
  /** Seconds since its last position. */
  seen: number;
}

/** Areas queried (centre, radius in nautical miles; adsb.lol allows up to 250): Alberta, BC, the north. */
const AREAS: [number, number, number][] = [[54.5, -115, 250], [51, -122.5, 250], [59, -118, 250]];
const HEADERS = { "User-Agent": "FIRE-WATCH wildfire map (github.com/SaladStik/Firewatch)", Accept: "application/json" };

export async function fetchFireAircraft(): Promise<{ aircraft: LiveAircraft[]; fetchedAt: string; seenAircraft: number }> {
  const out = new Map<string, LiveAircraft>();
  let seenAircraft = 0;
  for (const [i, [la, ln, r]] of AREAS.entries()) {
    if (i) await new Promise((res) => setTimeout(res, 1500)); // be gentle with a free community API
    const res = await fetch(`https://api.adsb.lol/v2/point/${la}/${ln}/${r}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`adsb.lol ${res.status}`);
    const j = (await res.json()) as { ac?: Record<string, unknown>[] };
    seenAircraft += j.ac?.length ?? 0;
    for (const a of j.ac ?? []) {
      const type = String(a.t ?? ""), t = FIRE_TYPES[type];
      const lat = Number(a.lat), lng = Number(a.lon);
      if (!t || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      // C-130s and 737s are mostly not tankers: keep those only when their callsign says so.
      const callsign = String(a.flight ?? "").trim();
      if ((type === "C130" || type === "B732") && !/^(TNK|TANKER|T\d{2,3}|CFR|FIRE)/i.test(callsign)) continue;
      out.set(String(a.hex), {
        hex: String(a.hex), reg: String(a.r ?? ""), callsign, type, role: t.role, name: t.name, lat, lng,
        altFt: a.alt_baro === "ground" ? null : Number(a.alt_baro) || null,
        gsKt: Number(a.gs) || 0, track: Number(a.track) || 0, seen: Number(a.seen_pos ?? a.seen) || 0,
      });
    }
  }
  return { aircraft: [...out.values()], fetchedAt: new Date().toISOString(), seenAircraft };
}
