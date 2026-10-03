/**
 * Calgary's live 311 queue: every open request (and open duplicate) of the crew field-work types,
 * with a location, from Open Calgary's 311 Service Requests dataset (data.calgary.ca iahh-g8bj,
 * Open Government Licence - City of Calgary). Updated by the city daily; ~20,000 rows.
 * Used by the data server (cached for everyone) and by the browser when there is no server.
 */
import { CREW_SERVICES, type Row311 } from "../dispatch/ops311";

const URL_311 = "https://data.calgary.ca/resource/iahh-g8bj.json";

export async function fetchOpen311(): Promise<{ rows: Row311[]; fetchedAt: string }> {
  const services = CREW_SERVICES.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
  const rows: Row311[] = [];
  for (let offset = 0; offset < 200000; offset += 50000) {
    const q = new URLSearchParams({
      $select: "service_request_id,requested_date,status_description,service_name,comm_name,location_type,latitude,longitude",
      $where: `status_description in ('Open','Duplicate (Open)') AND latitude IS NOT NULL AND service_name in (${services})`,
      $order: "service_request_id",
      $limit: "50000",
      $offset: String(offset),
    });
    const res = await fetch(`${URL_311}?${q}`);
    if (!res.ok) throw new Error(`Open Calgary 311 ${res.status}`);
    const page = (await res.json()) as Row311[];
    rows.push(...page);
    if (page.length < 50000) break;
  }
  return { rows, fetchedAt: new Date().toISOString() };
}
