/**
 * Canadian Wildland Fire Information System (Natural Resources Canada) — open WFS.
 * https://cwfis.cfs.nrcan.gc.ca  (CORS enabled, no key)
 */
const WFS = "https://cwfis.cfs.nrcan.gc.ca/geoserver/public/ows";

type BBox = [number, number, number, number];

function wfsUrl(typeName: string, bbox: BBox) {
  const p = new URLSearchParams({
    service: "WFS", version: "1.0.0", request: "GetFeature", outputFormat: "application/json",
    srsName: "EPSG:4326", typeName, bbox: `${bbox.join(",")},EPSG:4326`,
  });
  return `${WFS}?${p}`;
}

export interface Hotspot {
  id: string;
  lat: number;
  lng: number;
  time: string;
  /** Fire radiative power (MW). */
  frp: number;
  /** Canadian Fire Weather Index at the hotspot. */
  fwi: number;
  /** Head fire intensity (kW/m). */
  hfi: number;
  fuel: string;
  sensor: string;
  agency: string;
  /** Workspace index of the region it falls in. */
  region?: number;
}

export interface Perimeter {
  id: string;
  firstDate: string;
  lastDate: string;
  areaHa: number;
  hotspotCount: number;
  /** Rings as [lng, lat][]. */
  rings: [number, number][][];
  /** Workspace index of the region it falls in. */
  region?: number;
}

export async function fetchHotspots(bbox: BBox, signal?: AbortSignal): Promise<Hotspot[]> {
  const res = await fetch(wfsUrl("public:hotspots_last24hrs", bbox), { signal });
  if (!res.ok) throw new Error(`CWFIS hotspots ${res.status}`);
  const json = await res.json();
  return (json.features ?? []).map((f: { id: string; properties: Record<string, unknown> }) => {
    const p = f.properties;
    return {
      id: f.id,
      lat: Number(p.lat), lng: Number(p.lon), time: String(p.rep_date),
      frp: Number(p.frp ?? 0), fwi: Number(p.fwi ?? 0), hfi: Number(p.hfi ?? 0),
      fuel: String(p.fuel ?? "?"), sensor: String(p.sensor ?? "?"), agency: String(p.agency ?? "?"),
    };
  });
}

/** A CWFIS fire weather station's latest observed FWI moisture codes (CFFDRS). */
export interface FwiStation {
  lat: number;
  lng: number;
  date: string;
  ffmc: number;
  dmc: number;
  dc: number;
}

/** Every reporting station's current FFMC / DMC / DC (one small request, Canada-wide). */
export async function fetchFwiStations(signal?: AbortSignal): Promise<FwiStation[]> {
  const p = new URLSearchParams({
    service: "WFS", version: "1.0.0", request: "GetFeature", outputFormat: "application/json",
    typeName: "public:firewx_stns_current", propertyName: "lat,lon,rep_date,ffmc,dmc,dc",
  });
  const res = await fetch(`${WFS}?${p}`, { signal });
  if (!res.ok) throw new Error(`CWFIS stations ${res.status}`);
  const json = await res.json();
  return ((json.features ?? []) as { properties: Record<string, unknown> }[])
    .map(({ properties: q }) => ({ lat: Number(q.lat), lng: Number(q.lon), date: String(q.rep_date), ffmc: Number(q.ffmc), dmc: Number(q.dmc), dc: Number(q.dc) }))
    .filter((s) => [s.lat, s.lng, s.ffmc, s.dmc, s.dc].every(Number.isFinite));
}

export async function fetchPerimeters(bbox: BBox, signal?: AbortSignal): Promise<Perimeter[]> {
  const res = await fetch(wfsUrl("public:m3_polygons_current", bbox), { signal });
  if (!res.ok) throw new Error(`CWFIS perimeters ${res.status}`);
  const json = await res.json();
  return (json.features ?? []).map((f: { id: string; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }) => {
    const p = f.properties;
    const polys = (f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates]) as [number, number][][][];
    return {
      id: f.id,
      firstDate: String(p.firstdate), lastDate: String(p.lastdate),
      areaHa: Number(p.area ?? 0), hotspotCount: Number(p.hcount ?? 0),
      rings: polys.flat(),
    };
  });
}
