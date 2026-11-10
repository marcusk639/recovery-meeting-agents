import assert from "node:assert/strict";
import { test } from "node:test";
import type { Candidate } from "../domain/candidate.js";
import { applyPlan } from "./apply.js";
import {
  DIRECTORY,
  openDirectory,
  readExisting,
  readOwnRows,
} from "./firestore.js";
import { buildPlan, INGESTED_BY, type Plan, type PlannedRow } from "./plan.js";

const skip = !process.env.FIRESTORE_EMULATOR_HOST && "needs the emulator";

const PROJECT = "demo-meeting-agents";

const emptyPlan = (): Plan => ({
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
});

const apps = {} as PlannedRow["apps"];

const fields = (extra: Record<string, unknown> = {}) => ({
  source: "external",
  ingestedBy: INGESTED_BY,
  agentSourceId: "feed",
  name: "Row",
  ...extra,
});

test(
  "apply writes ours and leaves everyone else's alone",
  { skip },
  async () => {
    const db = openDirectory(PROJECT);
    const rows = db.collection(DIRECTORY);
    await rows.doc("taken-by-app").set({ source: "app", name: "Keep" });
    await rows.doc("taken-by-sync").set({ source: "external", name: "Keep" });
    await rows.doc("ours").set(
      fields({
        name: "Old",
        createdAt: "original",
        link: "https://zoom.us/j/old",
        location: { address: "Old St", lat: 1, lng: 2 },
      }),
    );
    await rows.doc("ours-gone").set(fields());

    const result = await applyPlan(db, {
      ...emptyPlan(),
      creates: [
        { id: "new", fields: fields({ name: "New" }), apps },
        { id: "taken-by-app", fields: fields({ name: "Overwrite" }), apps },
      ],
      refreshes: [
        {
          id: "ours",
          fields: fields({ name: "Updated", location: { lat: 3, lng: 4 } }),
          apps,
        },
        { id: "taken-by-sync", fields: fields({ name: "Overwrite" }), apps },
      ],
      deletes: ["ours-gone", "taken-by-sync", "taken-by-app"],
    });

    assert.deepEqual(result, {
      created: 1,
      refreshed: 1,
      deleted: 1,
      skipped: 4,
    });
    assert.equal((await rows.doc("taken-by-app").get()).data()?.name, "Keep");
    assert.equal((await rows.doc("taken-by-sync").get()).data()?.name, "Keep");
    assert.equal((await rows.doc("ours-gone").get()).exists, false);
    const ours = (await rows.doc("ours").get()).data();
    assert.equal(ours?.name, "Updated");
    assert.equal(ours?.createdAt, "original");
    // What the source stopped listing is gone, not merged forward.
    assert.equal(ours?.link, undefined);
    assert.deepEqual(ours?.location, { lat: 3, lng: 4 });
    assert.ok((await rows.doc("new").get()).data()?.createdAt);
    assert.ok((await rows.doc("new").get()).data()?.lastSeenAt);
  },
);

test(
  "a second publish of the same run creates nothing new",
  { skip },
  async () => {
    const db = openDirectory(PROJECT);
    const candidate: Candidate = {
      key: "repeat-key",
      origin: "feed",
      sourceId: "feed2",
      collectionKey: "feed2",
      sourceUrl: "https://intergroup.example/feed.json",
      dataAsOf: "2026-11-08",
      fellowship: "AA",
      name: "Repeat Group",
      day: 3,
      time: "12:00",
      formattedAddress: "1 A St",
      lat: 41.5,
      lng: -87.5,
      online: false,
    };
    const source = {
      id: "feed2",
      fellowship: "AA" as const,
      name: "F",
      url: "https://intergroup.example/feed.json",
      kind: "meeting-guide-feed" as const,
      status: "approved" as const,
      addedBy: "seed" as const,
    };
    const plan = async () =>
      buildPlan({
        candidates: [candidate],
        verdicts: new Map(),
        sources: new Map([["feed2", source]]),
        collections: [{ key: "feed2", status: "ok", records: 1 }],
        coordinates: new Map(),
        existing: await readExisting(db, [candidate], new Map()),
        ownRows: await readOwnRows(db, ["feed2"]),
        allowDeletes: true,
      });

    const first = await plan();
    assert.equal(first.creates.length, 1);
    await applyPlan(db, first);
    const stored = await db
      .collection(DIRECTORY)
      .doc("repeat-key")
      .get();
    assert.equal(stored.data()?.day, "wednesday");

    const second = await plan();
    assert.equal(second.creates.length, 0);
    assert.equal(second.refreshes.length, 1);
    assert.equal(second.deletes.length, 0);
  },
);
