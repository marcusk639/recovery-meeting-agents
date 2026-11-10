import { type Candidate, candidateDigest } from "../domain/candidate.js";
import { FELLOWSHIPS } from "../domain/fellowships.js";
import {
  conferenceHostAllowed,
  containsContactInfo,
} from "../domain/safety.js";
import { normalizeDay } from "../domain/identity.js";
import { INGESTED_BY } from "../domain/shapes.js";
import { type MeetingShapes, toShapes } from "../domain/toShapes.js";
import type { Source } from "../store/sourceRegistry.js";
import { type Comparable, sameMeeting } from "./duplicates.js";

export { INGESTED_BY };

/** Normal turnover is small. A bigger drop waits for a person to look at it. */
export const MAX_DELETE_FRACTION = 0.1;
/** Lets a small collection lose a few rows, where 10% would round down to nothing. */
export const MIN_DELETE_ALLOWANCE = 5;

const MAX_NAME_LENGTH = 200;

export interface ExistingRow {
  id: string;
  source?: string;
  provider?: string;
  name?: string;
  /** A day name, or 0-6 on a row written before recovery-api #207. */
  day?: number | string;
  time?: string;
  link?: string;
  externalId?: string;
  ingestedBy?: string;
  agentSourceId?: string;
  location?: { lat?: number; lng?: number };
}

export interface CollectionRecord {
  key: string;
  status: "ok" | "failed";
  records: number;
}

export interface Verdict {
  verdict: "confirmed" | "rejected";
  reason: string;
  /** What was checked, so a later change to the meeting can't inherit the verdict. */
  digest?: string;
}

export interface PlanInput {
  candidates: readonly Candidate[];
  verdicts: ReadonlyMap<string, Verdict>;
  sources: ReadonlyMap<string, Source>;
  collections: readonly CollectionRecord[];
  coordinates: ReadonlyMap<string, { lat: number; lng: number }>;
  /** Directory rows at the candidates' ids and near their locations. */
  existing: readonly ExistingRow[];
  /** Every row this repo wrote for the collections in this run. */
  ownRows: readonly ExistingRow[];
  allowDeletes: boolean;
}

export type HeldReason =
  | "provider-not-in-apps"
  | "source-not-approved"
  | "unsafe-content"
  | "unverified"
  | "rejected-by-verifier"
  | "no-coordinates"
  | "does-not-fit-shape";

export interface PlannedRow {
  id: string;
  fields: Record<string, unknown>;
  /** The same meeting as each app's own `meetings` collection stores it. */
  apps: Pick<MeetingShapes, "homegroups" | "regroup">;
}

export interface Plan {
  creates: PlannedRow[];
  refreshes: PlannedRow[];
  deletes: string[];
  /** Rows that would go if deletes were allowed. */
  wouldDelete: string[];
  held: Record<HeldReason, string[]>;
  alreadyListed: string[];
  blockedDeletes: { collection: string; missing: number; existing: number }[];
}

/** Feeds skip the verifier, so everything publishable is checked here, whatever its origin. */
function hasUnsafeContent(candidate: Candidate): boolean {
  if (candidate.name.length > MAX_NAME_LENGTH) return true;
  if (candidate.link && !conferenceHostAllowed(candidate.link)) return true;
  return [
    candidate.name,
    candidate.street,
    candidate.city,
    candidate.state,
    candidate.zip,
    candidate.locationName,
    candidate.format,
    candidate.type,
  ].some((value) => value !== undefined && containsContactInfo(value));
}

/** Why a candidate can't be published, whatever the directory holds. */
export function gate(
  candidate: Candidate,
  input: Pick<PlanInput, "verdicts" | "sources">,
): Exclude<HeldReason, "no-coordinates" | "does-not-fit-shape"> | null {
  if (!FELLOWSHIPS[candidate.fellowship].inApps) return "provider-not-in-apps";
  if (input.sources.get(candidate.sourceId)?.status !== "approved") {
    return "source-not-approved";
  }
  if (hasUnsafeContent(candidate)) return "unsafe-content";
  if (candidate.origin === "page") {
    const verdict = input.verdicts.get(candidate.key);
    if (verdict?.verdict === "rejected") return "rejected-by-verifier";
    if (
      verdict?.verdict !== "confirmed" ||
      verdict.digest !== candidateDigest(candidate)
    ) {
      return "unverified";
    }
  }
  return null;
}

function storedDay(day: number | string | undefined): number | undefined {
  if (day === undefined) return undefined;
  try {
    return normalizeDay(day);
  } catch {
    return undefined;
  }
}

const comparableRow = (row: ExistingRow): Comparable => ({
  provider: row.provider,
  name: row.name,
  day: storedDay(row.day),
  time: row.time,
  link: row.link,
  lat: row.location?.lat,
  lng: row.location?.lng,
  externalId: row.externalId,
  collection: row.agentSourceId,
});

const isOwn = (row: ExistingRow | undefined): boolean =>
  row?.ingestedBy === INGESTED_BY && row.source !== "app";

function planDeletes(input: PlanInput, plan: Plan): void {
  // Across every collection: a row one source dropped and another still lists stays.
  const listed = new Set(input.candidates.map((candidate) => candidate.key));

  for (const collection of input.collections) {
    if (collection.status !== "ok" || collection.records === 0) continue;
    const sourceId = collection.key.split("#")[0] ?? "";
    if (input.sources.get(sourceId)?.status !== "approved") continue;

    const rows = input.ownRows.filter(
      (row) => row.agentSourceId === collection.key && isOwn(row),
    );
    const missing = rows.filter((row) => !listed.has(row.id));
    if (missing.length === 0) continue;

    const allowance = Math.max(
      MIN_DELETE_ALLOWANCE,
      Math.floor(rows.length * MAX_DELETE_FRACTION),
    );
    if (missing.length > allowance) {
      plan.blockedDeletes.push({
        collection: collection.key,
        missing: missing.length,
        existing: rows.length,
      });
      continue;
    }
    plan.wouldDelete.push(...missing.map((row) => row.id));
  }
}

export function buildPlan(input: PlanInput): Plan {
  const plan: Plan = {
    creates: [],
    refreshes: [],
    deletes: [],
    wouldDelete: [],
    held: {
      "provider-not-in-apps": [],
      "source-not-approved": [],
      "unsafe-content": [],
      unverified: [],
      "rejected-by-verifier": [],
      "no-coordinates": [],
      "does-not-fit-shape": [],
    },
    alreadyListed: [],
    blockedDeletes: [],
  };

  const byId = new Map(input.existing.map((row) => [row.id, row]));
  const unique = new Map(input.candidates.map((c) => [c.key, c]));
  // A row already published goes first, so a duplicate skipped on an earlier
  // publish can't be taken for new on this one. Then feeds: when two sources list
  // one meeting, the structured row wins.
  const rank = (candidate: Candidate) => {
    if (isOwn(byId.get(candidate.key))) return 0;
    return candidate.origin === "feed" ? 1 : 2;
  };
  const ordered = [...unique.values()].sort((a, b) => rank(a) - rank(b));
  const planned: Comparable[] = [];

  for (const candidate of ordered) {
    const existing = byId.get(candidate.key);
    const held = gate(candidate, input);
    if (held) {
      plan.held[held].push(candidate.key);
      // A published meeting the verifier has since rejected has to come down.
      if (held === "rejected-by-verifier" && isOwn(existing)) {
        plan.wouldDelete.push(candidate.key);
      }
      continue;
    }

    const point = input.coordinates.get(candidate.key) ?? {
      lat: candidate.lat,
      lng: candidate.lng,
    };
    if (point.lat === undefined || point.lng === undefined) {
      plan.held["no-coordinates"].push(candidate.key);
      continue;
    }

    const shapes = toShapes(candidate, { lat: point.lat, lng: point.lng });
    if (!shapes) {
      plan.held["does-not-fit-shape"].push(candidate.key);
      continue;
    }
    const row: PlannedRow = {
      id: candidate.key,
      fields: shapes.directory,
      apps: { homegroups: shapes.homegroups, regroup: shapes.regroup },
    };

    const comparable: Comparable = {
      provider: candidate.fellowship,
      name: candidate.name,
      day: candidate.day,
      time: candidate.time,
      link: candidate.link,
      lat: point.lat,
      lng: point.lng,
      externalId: candidate.externalId,
      collection: candidate.collectionKey,
    };

    if (existing) {
      if (isOwn(existing)) {
        planned.push(comparable);
        plan.refreshes.push(row);
      } else {
        plan.alreadyListed.push(candidate.key);
      }
      continue;
    }

    // Any listed row counts, including this repo's from earlier publishes, except
    // one this collection no longer lists: that row is what this candidate replaces.
    const duplicate =
      input.existing.some(
        (other) =>
          !(
            isOwn(other) &&
            (unique.has(other.id) ||
              other.agentSourceId === candidate.collectionKey)
          ) && sameMeeting(comparable, comparableRow(other)),
      ) || planned.some((other) => sameMeeting(comparable, other));
    if (duplicate) {
      plan.alreadyListed.push(candidate.key);
      continue;
    }

    planned.push(comparable);
    plan.creates.push(row);
  }

  planDeletes(input, plan);
  if (input.allowDeletes) plan.deletes.push(...plan.wouldDelete);
  return plan;
}
