import type { RunStore } from "../store/runStore.js";
import type { SourceRegistry } from "../store/sourceRegistry.js";
import { type ApplyResult, applyPlan } from "./apply.js";
import { openDirectory, readExisting, readOwnRows } from "./firestore.js";
import { geocodeMissing, type Point } from "./geocode.js";
import { buildPlan, gate, type HeldReason } from "./plan.js";

export const DEFAULT_MAX_WRITES = 5000;

export interface PublishOptions {
  store: RunStore;
  registry: SourceRegistry;
  projectId: string;
  apply: boolean;
  allowDeletes: boolean;
  maxWrites: number;
}

/** Counts only: meeting details stay in the run's plan.json, out of any log. */
export interface PublishSummary {
  applied: boolean;
  projectId: string;
  candidates: number;
  creates: number;
  refreshes: number;
  deletes: number;
  wouldDelete: number;
  alreadyListed: number;
  held: Record<HeldReason, number>;
  blockedDeletes: { collection: string; missing: number; existing: number }[];
  failedCollections: string[];
  geocodeFailures: number;
  result?: ApplyResult;
}

/**
 * Reads the directory and works out what a run would change. Nothing is written
 * unless `apply` is set, and agents have no route to this code: it runs only
 * when a person, or a job a person sets up, invokes the publish command.
 */
export async function publish(
  options: PublishOptions,
): Promise<PublishSummary> {
  const { store, registry, projectId } = options;
  const db = openDirectory(projectId);

  const candidates = store.candidates();
  const verdicts = store.verdicts();
  const sources = registry.asMap();
  const collections = store.collections();
  const publishable = candidates.filter(
    (candidate) => gate(candidate, { verdicts, sources }) === null,
  );

  const cache =
    store.readJson<Record<string, Point | null>>("geocode.json") ?? {};
  const { coordinates, failed } = await geocodeMissing(publishable, cache);
  store.writeJson("geocode.json", cache);

  const plan = buildPlan({
    candidates,
    verdicts,
    sources,
    collections,
    coordinates,
    existing: await readExisting(db, publishable, coordinates),
    ownRows: await readOwnRows(
      db,
      collections.filter((c) => c.status === "ok").map((c) => c.key),
    ),
    allowDeletes: options.allowDeletes,
  });
  store.writeJson("plan.json", plan);

  // The same meetings in each stored shape. Timestamps are for whatever writes them.
  const rows = [...plan.creates, ...plan.refreshes];
  store.writeLines(
    "exports/directoryMeetings.jsonl",
    rows.map((row) => ({ id: row.id, ...row.fields })),
  );
  store.writeLines(
    "exports/homegroups-meetings.jsonl",
    rows.map((row) => row.apps.homegroups),
  );
  store.writeLines(
    "exports/regroup-meetings.jsonl",
    rows.map((row) => row.apps.regroup),
  );

  const held = Object.fromEntries(
    Object.entries(plan.held).map(([reason, keys]) => [reason, keys.length]),
  ) as Record<HeldReason, number>;
  const summary: PublishSummary = {
    applied: false,
    projectId,
    candidates: candidates.length,
    creates: plan.creates.length,
    refreshes: plan.refreshes.length,
    deletes: plan.deletes.length,
    wouldDelete: plan.wouldDelete.length,
    alreadyListed: plan.alreadyListed.length,
    held,
    blockedDeletes: plan.blockedDeletes,
    failedCollections: collections
      .filter((c) => c.status === "failed")
      .map((c) => c.key),
    geocodeFailures: failed,
  };
  if (!options.apply) return summary;

  const writes =
    plan.creates.length + plan.refreshes.length + plan.deletes.length;
  if (writes > options.maxWrites) {
    throw new Error(
      `This publish would make ${writes} writes, over the limit of ${options.maxWrites}. Review plan.json, then raise it with --max-writes.`,
    );
  }
  const result = await applyPlan(db, plan);
  store.writeJson("publish-result.json", result);
  return { ...summary, applied: true, result };
}
