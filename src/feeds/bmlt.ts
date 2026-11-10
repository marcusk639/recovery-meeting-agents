import { type Candidate, compact, joinAddress } from "../domain/candidate.js";
import { bmltMeetingId, normalizeTime } from "../domain/identity.js";
import { safeDialIn, safeHttpUrl } from "../domain/safety.js";

/**
 * The BMLT aggregator, the directory NA service bodies maintain. The mapping
 * follows recovery-api's `sources/bmlt.ts`, including its field allowlist, so
 * this and `npm run sync:na` give one meeting the same document id.
 */

export const BMLT_BASE = "https://aggregator.bmltenabled.org/main_server";

/** Only these are requested, so private contact fields never arrive. */
export const BMLT_FIELDS = [
  "source_id",
  "meeting_name",
  "weekday_tinyint",
  "start_time",
  "venue_type",
  "formats",
  "latitude",
  "longitude",
  "virtual_meeting_link",
  "phone_meeting_number",
  "location_street",
  "location_municipality",
  "location_province",
  "location_postal_code_1",
  "time_zone",
  "published",
] as const;

export interface BmltRegion {
  id: number;
  sourceId: number;
  name: string;
  expectedMeetings: number;
  lastSuccessfulImport: string | null;
}

export const regionsUrl = () => `${BMLT_BASE}/api/v1/rootservers`;

export function meetingsUrl(regionId: number): string {
  const params = new URLSearchParams({
    switcher: "GetSearchResults",
    root_server_ids: String(regionId),
    data_field_key: BMLT_FIELDS.join(","),
  });
  return `${BMLT_BASE}/client_interface/json/?${params}`;
}

export function parseRegions(body: unknown): BmltRegion[] {
  if (!Array.isArray(body)) throw new Error("BMLT returned no region list");
  return body.map((raw: Record<string, any>) => ({
    id: Number(raw.id),
    sourceId: Number(raw.sourceId),
    name: String(raw.name ?? ""),
    expectedMeetings: Number(raw.statistics?.meetings?.numTotal ?? 0),
    lastSuccessfulImport:
      typeof raw.lastSuccessfulImport === "string"
        ? raw.lastSuccessfulImport
        : null,
  }));
}

export function parseRows(body: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(body)
    ? body
    : (body as { meetings?: unknown } | null)?.meetings;
  if (!Array.isArray(rows)) throw new Error("BMLT returned an unexpected body");
  return rows;
}

const VENUE_VIRTUAL = "2";
const VENUE_HYBRID = "3";
const SERVICE_NAME = /\b(sub-?committee|committee|area service)\b/i;

const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

export interface BmltContext {
  sourceId: string;
  sourceUrl: string;
  dataAsOf: string;
}

export function mapBmltRow(
  row: Record<string, unknown>,
  region: BmltRegion,
  context: BmltContext,
): Candidate | null {
  try {
    const name = text(row.meeting_name);
    const formats = text(row.formats)
      .split(",")
      .map((code) => code.trim());
    if (formats.includes("ASM") || SERVICE_NAME.test(name)) return null;

    // BMLT numbers weekdays 1 (Sunday) to 7; the directory uses 0 to 6.
    const weekday = Number(text(row.weekday_tinyint) || row.weekday_tinyint);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return null;
    const meetingId = String(row.source_id ?? "").trim();
    if (!name || !meetingId || text(row.published) === "0") return null;

    const lat = Number.parseFloat(text(row.latitude));
    const lng = Number.parseFloat(text(row.longitude));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat === 0 && lng === 0) return null;

    const link = safeHttpUrl(row.virtual_meeting_link) ?? "";
    const phone = safeDialIn(row.phone_meeting_number) ?? "";
    const canJoin = Boolean(link || phone);
    const venue = text(row.venue_type);
    if (!canJoin && (venue === VENUE_VIRTUAL || formats.includes("TC"))) {
      return null;
    }

    const street = text(row.location_street);
    const city = text(row.location_municipality);
    const state = text(row.location_province);
    const zip = text(row.location_postal_code_1);
    const day = weekday - 1;
    const time = normalizeTime(text(row.start_time));

    return compact({
      key: bmltMeetingId(region.sourceId, meetingId),
      origin: "feed",
      sourceId: context.sourceId,
      collectionKey: `${context.sourceId}#${region.sourceId}`,
      sourceUrl: context.sourceUrl,
      dataAsOf: region.lastSuccessfulImport?.slice(0, 10) ?? context.dataAsOf,
      fellowship: "NA",
      name,
      day,
      time,
      street: street || undefined,
      city: city || undefined,
      state: state || undefined,
      zip: zip || undefined,
      formattedAddress: joinAddress({ street, city, state, zip }),
      lat,
      lng,
      online:
        venue === VENUE_VIRTUAL ||
        venue === VENUE_HYBRID ||
        (venue === "" && canJoin),
      link: link || undefined,
      onlineNotes: phone ? `Dial-in: ${phone}` : undefined,
      type: "NA",
      format: text(row.formats) || undefined,
      timezone: text(row.time_zone) || undefined,
      externalId: `${region.sourceId}:${meetingId}`,
      sourceRegion: String(region.sourceId),
    }) as Candidate;
  } catch {
    return null;
  }
}
