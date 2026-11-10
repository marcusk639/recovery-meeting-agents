import { distanceBetween } from "geofire-common";

const SAME_PLACE_METERS = 150;
const NAME_NOISE = new Set(["aa", "na", "cr", "the", "group", "meeting"]);

export interface Comparable {
  provider?: string | undefined;
  name?: string | undefined;
  day?: number | undefined;
  time?: string | undefined;
  link?: string | undefined;
  lat?: number | undefined;
  lng?: number | undefined;
  externalId?: string | undefined;
  /** The collection that listed it, which is what gives `externalId` meaning. */
  collection?: string | undefined;
}

function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token && !NAME_NOISE.has(token)),
  );
}

/**
 * The tokens must match exactly. A partial overlap would hide real meetings: a
 * building's "Men's Big Book" and "Women's Big Book" share all but one word, and
 * hiding a meeting is worse than listing one twice.
 */
function sameName(a: string, b: string): boolean {
  const left = nameTokens(a);
  const right = nameTokens(b);
  return (
    left.size > 0 &&
    left.size === right.size &&
    [...left].every((token) => right.has(token))
  );
}

/** One meeting found twice: same fellowship, slot and name, at one place or link. */
export function sameMeeting(a: Comparable, b: Comparable): boolean {
  if (a.provider !== b.provider || a.day !== b.day || a.time !== b.time) {
    return false;
  }
  // A source that gives two rows different ids says they are different meetings.
  if (
    a.collection &&
    a.collection === b.collection &&
    a.externalId &&
    b.externalId &&
    a.externalId !== b.externalId
  ) {
    return false;
  }
  if (!a.name || !b.name || !sameName(a.name, b.name)) return false;
  if (a.link && a.link === b.link) return true;
  if (
    a.lat === undefined ||
    a.lng === undefined ||
    b.lat === undefined ||
    b.lng === undefined
  ) {
    return false;
  }
  return (
    distanceBetween([a.lat, a.lng], [b.lat, b.lng]) * 1000 <= SAME_PLACE_METERS
  );
}
