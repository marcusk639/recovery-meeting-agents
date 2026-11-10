import { type Candidate, compact, joinAddress } from "../domain/candidate.js";
import type { Fellowship } from "../domain/fellowships.js";
import {
  directoryMeetingId,
  normalizeDay,
  normalizeTime,
} from "../domain/identity.js";
import { safeHttpUrl, scrubNotes, validPoint } from "../domain/safety.js";

/**
 * The Meeting Guide JSON format (github.com/code4recovery/spec), published by
 * AA intergroups and other fellowships using the same tools. Fields are read
 * from an allowlist, so `contact_*`, `entity_*` and `notes` are never touched.
 * The id follows recovery-api's `sources/meetingGuide.ts`, so both paths give
 * one meeting the same document.
 */

export interface FeedContext {
  sourceId: string;
  sourceUrl: string;
  fellowship: Fellowship;
  dataAsOf: string;
}

type Row = Record<string, unknown>;

/** Feeds send codes where stored rows hold words, such as "Big Book,Closed,English". */
const TYPE_LABELS: Record<string, string> = {
  "11": "11th Step Meditation",
  "12x12": "12 Steps & 12 Traditions",
  A: "Secular",
  AB: "As Bill Sees It",
  B: "Big Book",
  BE: "Newcomer",
  C: "Closed",
  CF: "Child-Friendly",
  D: "Discussion",
  DR: "Daily Reflections",
  EN: "English",
  ES: "Spanish",
  G: "Gay",
  GR: "Grapevine",
  H: "Birthday",
  L: "Lesbian",
  LGBTQ: "LGBTQIAA+",
  LIT: "Literature",
  M: "Men",
  MED: "Meditation",
  O: "Open",
  ONL: "Online Meeting",
  S: "Spanish",
  SP: "Speaker",
  ST: "Step Study",
  T: "Transgender",
  TC: "Temporary Closure",
  TR: "Tradition Study",
  W: "Women",
  X: "Wheelchair Access",
  Y: "Young People",
};

const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

function coordinate(value: unknown): number | undefined {
  const number =
    typeof value === "number" ? value : Number.parseFloat(text(value));
  return Number.isFinite(number) ? number : undefined;
}

function typeLabels(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value.map(String)
    : text(value).split(",");
  return values
    .map((code) => code.trim())
    .filter(Boolean)
    .map((code) => TYPE_LABELS[code] ?? code);
}

/** A 200 with the wrong body must count as a failed collection, not an empty one. */
export function parseFeed(body: unknown): Row[] {
  if (!Array.isArray(body)) {
    throw new Error("The feed did not return an array of meetings");
  }
  return body.filter(
    (row): row is Row => typeof row === "object" && row !== null,
  );
}

export function mapFeedMeeting(row: Row, context: FeedContext): Candidate[] {
  const name = text(row.name);
  if (!name) return [];

  const link = safeHttpUrl(row.conference_url);
  const phone = text(row.conference_phone);
  const canJoin = Boolean(link || phone);
  const labels = typeLabels(row.types);
  const closed = labels.includes(TYPE_LABELS.TC!);
  if (!canJoin && (closed || row.approximate === "yes")) return [];

  const days = Array.isArray(row.day) ? row.day : [row.day];
  const street = text(row.address);
  const city = text(row.city);
  const state = text(row.state);
  const zip = text(row.postal_code);
  // The id uses what recovery-api's mapper uses. The joined form is for geocoding.
  const idAddress = text(row.formatted_address) || street;
  const formattedAddress =
    text(row.formatted_address) || joinAddress({ street, city, state, zip });
  const lat = coordinate(row.latitude);
  const lng = coordinate(row.longitude);
  const hasPoint = validPoint(lat, lng);
  const types = labels.length > 0 ? labels.join(",") : undefined;

  return days.flatMap((rawDay) => {
    try {
      const day = normalizeDay(rawDay as number | string);
      const time = normalizeTime(text(row.time));
      const candidate: Candidate = compact({
        key: directoryMeetingId({
          name,
          day,
          time,
          link: link ?? "",
          formattedAddress: idAddress,
        }),
        origin: "feed",
        sourceId: context.sourceId,
        collectionKey: context.sourceId,
        sourceUrl: context.sourceUrl,
        dataAsOf: context.dataAsOf,
        fellowship: context.fellowship,
        name,
        day,
        time,
        street: street || undefined,
        city: city || undefined,
        state: state || undefined,
        zip: zip || undefined,
        country: text(row.country) || undefined,
        locationName: text(row.location) || undefined,
        formattedAddress,
        lat: hasPoint ? lat : undefined,
        lng: hasPoint ? lng : undefined,
        online: canJoin,
        link,
        onlineNotes:
          scrubNotes(row.conference_url_notes) ??
          scrubNotes(row.conference_phone_notes),
        type: types,
        format: types,
        timezone: text(row.timezone) || undefined,
        externalId: text(row.slug) || undefined,
      }) as Candidate;
      return [candidate];
    } catch {
      return [];
    }
  });
}
