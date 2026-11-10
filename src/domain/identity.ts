// @ts-nocheck: an unmodified copy, type-checked by recovery-api's own tsconfig (see identity.contract.test.ts).
import { createHash } from 'crypto';
import { geohashForLocation } from 'geofire-common';

/**
 * FROZEN identity scheme for the shared meeting directory.
 *
 * There must be EXACTLY ONE content hash recipe and ONE geohash precision repo-wide
 * on the directory path. homegroups drifted across precision 5/8/9/10 and across
 * day/time representations, producing duplicate + orphan docs. Do not add another
 * hashing or geohash helper. The one exception is bmltMeetingId, for a source whose
 * own ids are reliable enough to key on.
 *
 * Recipe ported from homegroups `scripts/cleanMeetings.ts` (generateMeetingHash):
 *   sha1(name | day | time | link | formattedAddress).slice(0, 24)
 * — but hashing the NORMALIZED day/time so equivalent representations
 * ("Tuesday" ≡ 2, "7:00 AM" ≡ "07:00") collapse to one id.
 */

/**
 * Frozen geohash precision. geofire-common's default is 10; homegroups'
 * read path (findMeetingsByLocation.ts) also uses 10. The `GEOHASH_PRECISION: 5`
 * in homegroups CONFIG was coarse-cell drift and is deliberately NOT used here.
 */
export const GEOHASH_PRECISION = 10;

// 0 = Sunday .. 6 = Saturday (JS getDay convention; matches both products' daysOfWeek).
const DAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/** How the directory stores a meeting's day: a lowercase weekday name. */
export type DayName = (typeof DAYS)[number];

export const DAY_NAMES: readonly DayName[] = DAYS;

/**
 * Canonical stored day: the lowercase weekday name. Accepts every form
 * normalizeDay does, and throws on the same bad input.
 */
export function toDayName(input: number | string): DayName {
  return DAYS[normalizeDay(input)];
}

/**
 * Id for a BMLT meeting, from the region and the meeting's id on that region's server.
 * Across 35,788 live rows this pair was unique, while the meeting id alone repeated
 * between regions. Unlike directoryMeetingId it doesn't change when a meeting is
 * edited, so a rename or time change updates one document instead of replacing it.
 */
export function bmltMeetingId(regionSourceId: number, meetingId: string | number): string {
  const parts = ['bmlt', String(regionSourceId), String(meetingId)].join(ID_FIELD_SEP);
  return createHash('sha1').update(parts).digest('hex').slice(0, 24);
}

/**
 * Canonicalize a day-of-week to an integer 0–6 (0 = Sunday).
 * Accepts an integer, a numeric string, a full weekday name, or any unambiguous
 * abbreviation that is a genuine prefix of the name and ≥3 chars
 * (case-insensitive: "Sun", "Tue", "Tues", "Thurs", "Wed"). Throws on anything
 * else so bad source data surfaces rather than silently producing a divergent id.
 * Note: "Weds" is not a prefix of "wednesday" — use "Wed".
 */
export function normalizeDay(input: number | string): number {
  if (typeof input === 'number') {
    if (Number.isInteger(input) && input >= 0 && input <= 6) return input;
    throw new RangeError(`normalizeDay: out-of-range day index: ${input}`);
  }

  const raw = input.trim().toLowerCase();
  if (!raw) {
    throw new RangeError('normalizeDay: empty day');
  }
  if (/^[0-6]$/.test(raw)) return Number(raw);

  const exact = DAYS.findIndex((d) => d === raw);
  if (exact !== -1) return exact;

  // Prefix match for abbreviations. Require ≥3 chars so 1–2 letter prefixes
  // (ambiguous: s→sun/sat, t→tue/thu) can never match; at length 3 every prefix
  // in this set resolves to a single day.
  if (raw.length >= 3) {
    const prefix = DAYS.findIndex((d) => d.startsWith(raw));
    if (prefix !== -1) return prefix;
  }

  throw new RangeError(`normalizeDay: unrecognized day: ${JSON.stringify(input)}`);
}

/**
 * Canonicalize a local start time to "HH:mm" (24-hour). Accepts "HH:mm",
 * "HH:mm:ss", single-digit hours, and 12-hour "h:mm AM/PM". Throws on invalid.
 */
export function normalizeTime(input: string): string {
  const m = input.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/);
  if (!m) {
    throw new RangeError(`normalizeTime: unrecognized time: ${JSON.stringify(input)}`);
  }

  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[3]?.toLowerCase();

  if (minute > 59) {
    throw new RangeError(`normalizeTime: minute out of range: ${JSON.stringify(input)}`);
  }

  if (meridiem) {
    if (hour < 1 || hour > 12) {
      throw new RangeError(`normalizeTime: 12-hour out of range: ${JSON.stringify(input)}`);
    }
    if (meridiem === 'am') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 23) {
    throw new RangeError(`normalizeTime: 24-hour out of range: ${JSON.stringify(input)}`);
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** geofire-common geohash at the frozen precision. */
export function directoryGeohash(lat: number, lng: number): string {
  return geohashForLocation([lat, lng], GEOHASH_PRECISION);
}

export interface DirectoryMeetingIdInput {
  name: string;
  day: number | string;
  time: string;
  link?: string;
  formattedAddress?: string;
}

// Field separator for the hash preimages. A NUL byte is used (not "|") so a
// literal separator inside a free-form field (name/address from external
// sources, e.g. "Suite 100 | Bldg B") can't shift field boundaries and collide
// two distinct meetings onto the same id. NUL never appears in real source text.
const ID_FIELD_SEP = '\u0000';

/**
 * Deterministic 24-char directory id. Pure function of the meeting's identifying
 * fields, hashed AFTER normalization so format variants collapse to one id.
 * `day` is deliberately part of the key (the same room hosts distinct meetings
 * on different days).
 *
 * `name`/`formattedAddress` are case-SENSITIVE by design (matches the ported
 * homegroups recipe). If a source is known to vary capitalization for the same
 * real meeting, the INGESTOR must normalize case before calling this — otherwise
 * "Sunrise Group" and "SUNRISE GROUP" produce two directory docs.
 */
export function directoryMeetingId(m: DirectoryMeetingIdInput): string {
  const parts = [
    m.name.trim(),
    String(normalizeDay(m.day)),
    normalizeTime(m.time),
    (m.link ?? '').trim(),
    (m.formattedAddress ?? '').trim(),
  ].join(ID_FIELD_SEP);

  return createHash('sha1').update(parts).digest('hex').slice(0, 24);
}
