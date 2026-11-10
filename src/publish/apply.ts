import {
  type DocumentReference,
  FieldValue,
  type Firestore,
} from "firebase-admin/firestore";
import { DIRECTORY } from "./firestore.js";
import { INGESTED_BY, type Plan, type PlannedRow } from "./plan.js";

const BATCH_SIZE = 400;

const OPTIONAL_FIELDS = [
  "type",
  "format",
  "link",
  "onlineNotes",
  "timezone",
  "externalId",
  "sourceRegion",
];

export interface ApplyResult {
  created: number;
  refreshed: number;
  deleted: number;
  /** Rows that changed hands between planning and writing, and were left alone. */
  skipped: number;
}

/**
 * The plan was built from an earlier read, so each row is re-read here: another
 * sync or an app may have written it since, and those rows are not ours to change.
 */
export async function applyPlan(
  db: Firestore,
  plan: Plan,
): Promise<ApplyResult> {
  const result: ApplyResult = {
    created: 0,
    refreshed: 0,
    deleted: 0,
    skipped: 0,
  };
  const collection = db.collection(DIRECTORY);

  async function eachExisting(
    ids: readonly string[],
    visit: (
      ref: DocumentReference,
      exists: boolean,
      data: Record<string, unknown> | undefined,
      batch: FirebaseFirestore.WriteBatch,
    ) => void,
  ): Promise<void> {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const slice = ids.slice(i, i + BATCH_SIZE);
      const docs = await db.getAll(...slice.map((id) => collection.doc(id)));
      const batch = db.batch();
      for (const doc of docs) visit(doc.ref, doc.exists, doc.data(), batch);
      await batch.commit();
    }
  }

  const stamps = () => ({
    lastRefreshedAt: FieldValue.serverTimestamp(),
    lastSeenAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const fieldsById = (rows: readonly PlannedRow[]) =>
    new Map(rows.map((row) => [row.id, row.fields]));

  const creates = fieldsById(plan.creates);
  await eachExisting([...creates.keys()], (ref, exists, _data, batch) => {
    if (exists) {
      result.skipped++;
      return;
    }
    batch.set(ref, {
      ...creates.get(ref.id),
      ...stamps(),
      createdAt: FieldValue.serverTimestamp(),
    });
    result.created++;
  });

  const refreshes = fieldsById(plan.refreshes);
  await eachExisting([...refreshes.keys()], (ref, exists, data, batch) => {
    if (!exists || data?.ingestedBy !== INGESTED_BY || data.source === "app") {
      result.skipped++;
      return;
    }
    // update() replaces `location` whole, and the deletes clear what a source
    // stopped listing, such as a link. A merge would keep the old values.
    const fields = refreshes.get(ref.id) ?? {};
    const cleared = Object.fromEntries(
      OPTIONAL_FIELDS.filter((field) => !(field in fields)).map((field) => [
        field,
        FieldValue.delete(),
      ]),
    );
    batch.update(ref, { ...cleared, ...fields, ...stamps() });
    result.refreshed++;
  });

  await eachExisting(plan.deletes, (ref, exists, data, batch) => {
    if (!exists || data?.ingestedBy !== INGESTED_BY || data.source === "app") {
      result.skipped++;
      return;
    }
    batch.delete(ref);
    result.deleted++;
  });

  return result;
}
