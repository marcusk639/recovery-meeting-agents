import { createHash } from "node:crypto";
import { z } from "zod";
import { FELLOWSHIP_IDS, type Fellowship } from "./fellowships.js";
import { directoryMeetingId, normalizeDay, normalizeTime } from "./identity.js";
import {
  conferenceHostAllowed,
  containsContactInfo,
  safeHttpUrl,
} from "./safety.js";
import { WEEKDAYS } from "./shapes.js";

/** A meeting read from a source, before anyone decides whether to publish it. */
export interface Candidate {
  /** The directory document id it would have. */
  key: string;
  origin: "feed" | "page";
  sourceId: string;
  /** What a later sweep of the same thing would replace: a source, or one region of it. */
  collectionKey: string;
  sourceUrl: string;
  /** "YYYY-MM-DD" the source last confirmed the row; apps show its age. */
  dataAsOf: string;
  fellowship: Fellowship;
  name: string;
  day: number;
  time: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  locationName?: string;
  formattedAddress: string;
  lat?: number;
  lng?: number;
  online: boolean;
  link?: string;
  onlineNotes?: string;
  type?: string;
  format?: string;
  timezone?: string;
  externalId?: string;
  sourceRegion?: string;
  evidence?: { snapshotId: string; quote: string };
}

/** Strict, so a contact field an extractor adds is an error instead of data. */
export const PageMeetingInput = z.strictObject({
  fellowship: z.enum(FELLOWSHIP_IDS),
  name: z.string().min(2).max(200),
  day: z.union([z.number().int().min(0).max(6), z.string().max(20)]),
  time: z.string().max(20),
  street: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(40).optional(),
  zip: z.string().max(12).optional(),
  locationName: z.string().max(200).optional(),
  online: z.boolean(),
  link: z.string().max(500).optional(),
  format: z.string().max(100).optional(),
  quote: z.string().min(10).max(800),
});
export type PageMeetingInput = z.infer<typeof PageMeetingInput>;

export interface Snapshot {
  id: string;
  url: string;
  fetchedAt: string;
  text: string;
}

export type CandidateResult =
  { ok: true; candidate: Candidate } | { ok: false; reason: string };

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole words only, so "Main St" can't match inside "Main Street Hall", or "Mon" in "Monroe". */
function hasPhrase(haystack: string, phrase: string): boolean {
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegex(squash(phrase))}(?![\\p{L}\\p{N}])`,
    "u",
  ).test(haystack);
}

/** The ways a page can write this time. A bare "7:00" fits none: it could be either. */
function timeInText(text: string, time: string): boolean {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  const hour12 = hours % 12 || 12;
  const mm = String(minutes).padStart(2, "0");
  const meridiem = hours < 12 ? "a\\.?m\\.?" : "p\\.?m\\.?";
  const forms = [
    `${hour12}:${mm}\\s*${meridiem}`,
    ...(minutes === 0 ? [`${hour12}\\s*${meridiem}`] : []),
    ...(time === "12:00" ? ["noon"] : []),
    ...(time === "00:00" ? ["midnight"] : []),
    ...(hours >= 13 || time.startsWith("0") ? [time] : []),
  ];
  return new RegExp(
    `(?<![\\d:])(${forms.join("|")})(?![\\p{L}\\p{N}])`,
    "u",
  ).test(text);
}

export function joinAddress(parts: {
  street?: string | undefined;
  city?: string | undefined;
  state?: string | undefined;
  zip?: string | undefined;
}): string {
  const stateZip = [parts.state, parts.zip].filter(Boolean).join(" ");
  return [parts.street, parts.city, stateZip].filter(Boolean).join(", ");
}

/** Drops undefined values, which exactOptionalPropertyTypes and Firestore both refuse. */
export function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}

/** Ties a verdict to what was checked, so a later resubmission can't inherit it. */
export function candidateDigest(candidate: Candidate): string {
  return createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
}

/**
 * Every field must trace back to the fetched page. A model can misread a page or
 * invent a meeting, and a page can try to steer it, so these checks run in code.
 * Code can't tell which row a value belongs to; the verifier checks that.
 */
export function pageCandidate(
  input: PageMeetingInput,
  context: { sourceId: string; snapshot: Snapshot },
): CandidateResult {
  const { snapshot, sourceId } = context;
  const page = squash(snapshot.text);
  const quote = squash(input.quote);
  const name = input.name.trim();

  if (!page.includes(quote)) return { ok: false, reason: "quote-not-on-page" };
  if (!quote.includes(squash(name))) {
    return { ok: false, reason: "name-not-in-quote" };
  }

  const texts = [
    name,
    input.street,
    input.city,
    input.state,
    input.zip,
    input.locationName,
    input.format,
  ].filter((value): value is string => Boolean(value));
  if (texts.some(containsContactInfo)) {
    return { ok: false, reason: "contact-info" };
  }

  for (const [reason, value] of [
    ["street-not-on-page", input.street],
    ["city-not-on-page", input.city],
    ["state-not-on-page", input.state],
    ["zip-not-on-page", input.zip],
    ["location-name-not-on-page", input.locationName],
    ["format-not-on-page", input.format],
  ] as const) {
    if (value && !hasPhrase(page, value)) return { ok: false, reason };
  }
  // A number is what makes a street a place. "Main St" alone geocodes anywhere.
  if (input.street && !/\d/.test(input.street)) {
    return { ok: false, reason: "street-too-vague" };
  }

  let link: string | undefined;
  if (input.link) {
    link = safeHttpUrl(input.link);
    if (!link) return { ok: false, reason: "bad-link" };
    if (!snapshot.text.includes(link)) {
      return { ok: false, reason: "link-not-on-page" };
    }
    if (!conferenceHostAllowed(link)) {
      return { ok: false, reason: "link-host-not-allowed" };
    }
  }

  let day: number;
  let time: string;
  try {
    day = normalizeDay(input.day);
    time = normalizeTime(input.time);
  } catch {
    return { ok: false, reason: "bad-day-or-time" };
  }
  if (!timeInText(quote, time)) {
    return { ok: false, reason: "time-not-in-quote" };
  }
  // A day may be in a heading above the row, so it's checked against the page.
  const weekday = WEEKDAYS[day] ?? "";
  if (!hasPhrase(page, weekday) && !hasPhrase(page, weekday.slice(0, 3))) {
    return { ok: false, reason: "day-not-on-page" };
  }

  if (!input.online && !input.street) {
    return { ok: false, reason: "no-address" };
  }
  if (input.online && !link && !input.street) {
    return { ok: false, reason: "no-way-to-join" };
  }

  const formattedAddress = joinAddress(input);
  return {
    ok: true,
    candidate: compact({
      key: directoryMeetingId({
        name,
        day,
        time,
        link: link ?? "",
        formattedAddress,
      }),
      origin: "page",
      sourceId,
      collectionKey: sourceId,
      sourceUrl: snapshot.url,
      dataAsOf: snapshot.fetchedAt,
      fellowship: input.fellowship,
      name,
      day,
      time,
      street: input.street,
      city: input.city,
      state: input.state,
      zip: input.zip,
      locationName: input.locationName,
      formattedAddress,
      online: input.online,
      link,
      format: input.format,
      evidence: { snapshotId: snapshot.id, quote: input.quote },
    }) as Candidate,
  };
}
