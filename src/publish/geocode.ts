import type { Candidate } from "../domain/candidate.js";

const CENSUS_URL =
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

export interface Point {
  lat: number;
  lng: number;
}

/** The US Census geocoder: keyless and free. A street with no match returns null. */
export async function geocodeCensus(
  address: string,
  fetchFn: typeof fetch = fetch,
): Promise<Point | null> {
  const params = new URLSearchParams({
    address,
    benchmark: "Public_AR_Current",
    format: "json",
  });
  const response = await fetchFn(`${CENSUS_URL}?${params}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Census answered ${response.status}`);
  const body = (await response.json()) as {
    result?: {
      addressMatches?: { coordinates?: { x?: number; y?: number } }[];
    };
  };
  const matches = body.result?.addressMatches;
  if (!Array.isArray(matches)) throw new Error("Census returned no result");
  // Several matches mean the address is ambiguous. Guessing could send someone to the wrong place.
  if (matches.length !== 1) return null;
  const { x, y } = matches[0]?.coordinates ?? {};
  return typeof x === "number" && typeof y === "number"
    ? { lat: y, lng: x }
    : null;
}

/**
 * Fills in coordinates for candidates lacking them. Coordinates never come from a
 * model, because a guessed point would send someone to the wrong place. Only a
 * street address is tried, and a failed request isn't cached, so a retry can work.
 */
export async function geocodeMissing(
  candidates: readonly Candidate[],
  cache: Record<string, Point | null>,
  geocode: (address: string) => Promise<Point | null> = geocodeCensus,
): Promise<{ coordinates: Map<string, Point>; failed: number }> {
  const coordinates = new Map<string, Point>();
  let failed = 0;
  for (const candidate of candidates) {
    if (candidate.lat !== undefined && candidate.lng !== undefined) continue;
    if (!candidate.street) continue;
    const address = candidate.formattedAddress;
    if (!Object.hasOwn(cache, address)) {
      try {
        cache[address] = await geocode(address);
      } catch {
        failed++;
        continue;
      }
    }
    const point = cache[address];
    if (point) coordinates.set(candidate.key, point);
  }
  return { coordinates, failed };
}
