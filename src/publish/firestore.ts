import { getApps, initializeApp } from "firebase-admin/app";
import {
  type Firestore,
  getFirestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { geohashQueryBounds } from "geofire-common";
import type { Candidate } from "../domain/candidate.js";
import type { ExistingRow } from "./plan.js";

export const DIRECTORY = "directoryMeetings";
export const PRODUCTION_PROJECT = "recovery-platform-e6cb3";

const NEARBY_METERS = 300;
const PAGE_SIZE = 500;
const ID_CHUNK = 300;
const CONCURRENT_QUERIES = 10;

/** Only the shared directory's project, or a throwaway emulator project. */
export function assertAllowedProject(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (projectId === PRODUCTION_PROJECT) return;
  if (env.FIRESTORE_EMULATOR_HOST && projectId.startsWith("demo-")) return;
  throw new Error(
    `Refusing project "${projectId}". Use ${PRODUCTION_PROJECT}, or a demo- project with FIRESTORE_EMULATOR_HOST set.`,
  );
}

export function openDirectory(projectId: string): Firestore {
  assertAllowedProject(projectId);
  const name = `meeting-agents-${projectId}`;
  const app =
    getApps().find((candidate) => candidate.name === name) ??
    initializeApp({ projectId }, name);
  return getFirestore(app);
}

const toRow = (doc: { id: string; data(): unknown }): ExistingRow => ({
  id: doc.id,
  ...(doc.data() as Omit<ExistingRow, "id">),
});

async function inBatches<T>(
  items: readonly T[],
  size: number,
  run: (batch: readonly T[]) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await run(items.slice(i, i + size));
  }
}

async function readBound(
  db: Firestore,
  start: string,
  end: string,
): Promise<QueryDocumentSnapshot[]> {
  const docs: QueryDocumentSnapshot[] = [];
  let last: QueryDocumentSnapshot | undefined;
  for (;;) {
    const ordered = db.collection(DIRECTORY).orderBy("location.geohash");
    const page = await (
      last ? ordered.startAfter(last) : ordered.startAt(start)
    )
      .endAt(end)
      .limit(PAGE_SIZE)
      .get();
    docs.push(...page.docs);
    if (page.docs.length < PAGE_SIZE) return docs;
    last = page.docs[page.docs.length - 1];
  }
}

/**
 * Reads only the rows at the candidates' ids and around their locations, because
 * a full scan of a Firestore collection has already exhausted a project's quota.
 */
export async function readExisting(
  db: Firestore,
  candidates: readonly Candidate[],
  coordinates: ReadonlyMap<string, { lat: number; lng: number }>,
): Promise<ExistingRow[]> {
  const rows = new Map<string, ExistingRow>();

  const refs = candidates.map((c) => db.collection(DIRECTORY).doc(c.key));
  await inBatches(refs, ID_CHUNK, async (batch) => {
    if (batch.length === 0) return;
    for (const doc of await db.getAll(...batch)) {
      if (doc.exists) rows.set(doc.id, toRow(doc));
    }
  });

  const bounds = new Map<string, [string, string]>();
  for (const candidate of candidates) {
    const point = coordinates.get(candidate.key) ?? {
      lat: candidate.lat,
      lng: candidate.lng,
    };
    if (point.lat === undefined || point.lng === undefined) continue;
    for (const [start, end] of geohashQueryBounds(
      [point.lat, point.lng],
      NEARBY_METERS,
    )) {
      bounds.set(`${start}:${end}`, [start, end]);
    }
  }
  await inBatches([...bounds.values()], CONCURRENT_QUERIES, async (batch) => {
    const pages = await Promise.all(
      batch.map(([start, end]) => readBound(db, start, end)),
    );
    for (const doc of pages.flat()) rows.set(doc.id, toRow(doc));
  });

  return [...rows.values()];
}

export async function readOwnRows(
  db: Firestore,
  collectionKeys: readonly string[],
): Promise<ExistingRow[]> {
  const rows: ExistingRow[] = [];
  for (const key of collectionKeys) {
    let last: QueryDocumentSnapshot | undefined;
    for (;;) {
      const query = db
        .collection(DIRECTORY)
        .where("agentSourceId", "==", key)
        .orderBy("__name__")
        .limit(PAGE_SIZE);
      const page = await (last ? query.startAfter(last) : query).get();
      rows.push(...page.docs.map(toRow));
      if (page.docs.length < PAGE_SIZE) break;
      last = page.docs[page.docs.length - 1];
    }
  }
  return rows;
}
