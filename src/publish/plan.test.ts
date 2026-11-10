import assert from "node:assert/strict";
import { test } from "node:test";
import { type Candidate, candidateDigest } from "../domain/candidate.js";
import type { Source } from "../store/sourceRegistry.js";
import {
  buildPlan,
  type CollectionRecord,
  type ExistingRow,
  INGESTED_BY,
  type PlanInput,
} from "./plan.js";

const source = (over: Partial<Source> = {}): Source => ({
  id: "feed",
  fellowship: "AA",
  name: "Feed",
  url: "https://intergroup.example/feed.json",
  kind: "meeting-guide-feed",
  status: "approved",
  addedBy: "seed",
  ...over,
});

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  key: "k1",
  origin: "feed",
  sourceId: "feed",
  collectionKey: "feed",
  sourceUrl: "https://intergroup.example/feed.json",
  dataAsOf: "2026-11-08",
  fellowship: "AA",
  name: "Sunrise Group",
  day: 1,
  time: "07:00",
  formattedAddress: "100 Main St, Austin, TX",
  lat: 30.2672,
  lng: -97.7431,
  online: false,
  ...over,
});

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  candidates: [candidate()],
  verdicts: new Map(),
  sources: new Map([["feed", source()]]),
  collections: [],
  coordinates: new Map(),
  existing: [],
  ownRows: [],
  allowDeletes: false,
  ...over,
});

const own = (id: string, collection = "feed"): ExistingRow => ({
  id,
  source: "external",
  ingestedBy: INGESTED_BY,
  agentSourceId: collection,
});

const healthy: CollectionRecord = { key: "feed", status: "ok", records: 1 };

test("a new meeting from an approved source is created with its age shown", () => {
  const plan = buildPlan(input());
  assert.equal(plan.creates.length, 1);
  const row = plan.creates[0]!;
  assert.equal(row.id, "k1");
  assert.equal(row.fields.source, "external");
  assert.equal(row.fields.provider, "AA");
  assert.equal(row.fields.dataAsOf, "2026-11-08");
  assert.equal(row.fields.ingestedBy, INGESTED_BY);
  assert.equal(row.fields.agentSourceId, "feed");
  assert.equal((row.fields.location as { geohash: string }).geohash.length, 10);
});

test("a fellowship the apps can't show is held", () => {
  const plan = buildPlan(
    input({ candidates: [candidate({ fellowship: "SMART_RECOVERY" })] }),
  );
  assert.equal(plan.creates.length, 0);
  assert.deepEqual(plan.held["provider-not-in-apps"], ["k1"]);
});

test("a source nobody approved publishes nothing", () => {
  const plan = buildPlan(
    input({ sources: new Map([["feed", source({ status: "proposed" })]]) }),
  );
  assert.deepEqual(plan.held["source-not-approved"], ["k1"]);
  const missing = buildPlan(input({ sources: new Map() }));
  assert.deepEqual(missing.held["source-not-approved"], ["k1"]);
});

test("a page meeting needs an independent confirmation", () => {
  const page = candidate({ origin: "page" });
  const pending = buildPlan(input({ candidates: [page] }));
  assert.deepEqual(pending.held.unverified, ["k1"]);
  const rejected = buildPlan(
    input({
      candidates: [page],
      verdicts: new Map([["k1", { verdict: "rejected", reason: "x" }]]),
    }),
  );
  assert.deepEqual(rejected.held["rejected-by-verifier"], ["k1"]);
  const confirmed = buildPlan(
    input({
      candidates: [page],
      verdicts: new Map([
        [
          "k1",
          { verdict: "confirmed", reason: "x", digest: candidateDigest(page) },
        ],
      ]),
    }),
  );
  assert.equal(confirmed.creates.length, 1);
});

test("a meeting with no coordinates uses the geocoded ones or waits", () => {
  const { lat: _lat, lng: _lng, ...base } = candidate();
  const noCoords = base as Candidate;
  const held = buildPlan(input({ candidates: [noCoords] }));
  assert.deepEqual(held.held["no-coordinates"], ["k1"]);
  const geocoded = buildPlan(
    input({
      candidates: [noCoords],
      coordinates: new Map([["k1", { lat: 30, lng: -97 }]]),
    }),
  );
  assert.equal(geocoded.creates.length, 1);
});

test("an app-owned row is never touched", () => {
  const plan = buildPlan(input({ existing: [{ id: "k1", source: "app" }] }));
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.refreshes, []);
  assert.deepEqual(plan.alreadyListed, ["k1"]);
});

test("a row another sync owns is left to it", () => {
  const plan = buildPlan(
    input({ existing: [{ id: "k1", source: "external" }] }),
  );
  assert.deepEqual(plan.refreshes, []);
  assert.deepEqual(plan.alreadyListed, ["k1"]);
});

for (const day of [1, "monday"]) {
  test(`the same meeting under another id isn't listed twice (stored day ${day})`, () => {
    const plan = buildPlan(
      input({
        existing: [
          {
            id: "other",
            source: "external",
            provider: "AA",
            name: "SUNRISE GROUP (AA)",
            day,
            time: "07:00",
            location: { lat: 30.26725, lng: -97.74315 },
          },
        ],
      }),
    );
    assert.deepEqual(plan.creates, []);
    assert.deepEqual(plan.alreadyListed, ["k1"]);
  });
}

test("two sources listing one meeting create one row, preferring the feed", () => {
  const page = candidate({
    key: "k2",
    origin: "page",
    sourceId: "feed",
    name: "Sunrise",
  });
  const plan = buildPlan(
    input({
      candidates: [page, candidate()],
      verdicts: new Map([
        [
          "k2",
          { verdict: "confirmed", reason: "x", digest: candidateDigest(page) },
        ],
      ]),
    }),
  );
  assert.deepEqual(
    plan.creates.map((row) => row.id),
    ["k1"],
  );
});

test("a duplicate skipped on the first publish stays skipped on the next", () => {
  const twin = candidate({ key: "k2", name: "Sunrise" });
  const published = own("k1");
  for (const candidates of [
    [candidate(), twin],
    [twin, candidate()],
  ]) {
    const plan = buildPlan(
      input({ candidates, existing: [published], ownRows: [published] }),
    );
    assert.deepEqual(plan.creates, []);
    assert.deepEqual(
      plan.refreshes.map((row) => row.id),
      ["k1"],
    );
    assert.deepEqual(plan.alreadyListed, ["k2"]);
  }
});

test("sibling meetings in one building are both kept", () => {
  const plan = buildPlan(
    input({
      candidates: [
        candidate({ key: "men", name: "Men's Big Book Study" }),
        candidate({ key: "women", name: "Women's Big Book Study" }),
        candidate({ key: "plain", name: "Serenity" }),
        candidate({ key: "women2", name: "Serenity Women" }),
      ],
    }),
  );
  assert.equal(plan.creates.length, 4);
  assert.deepEqual(plan.alreadyListed, []);
});

test("two rows a source gives different ids are two meetings", () => {
  const plan = buildPlan(
    input({
      candidates: [
        candidate({ key: "a", externalId: "1" }),
        candidate({ key: "b", externalId: "2" }),
      ],
    }),
  );
  assert.equal(plan.creates.length, 2);
});

test("our row from an earlier publish still counts as listed", () => {
  const earlier: ExistingRow = {
    ...own("from-page", "other-source"),
    provider: "AA",
    name: "Sunrise Group",
    day: 1,
    time: "07:00",
    location: { lat: 30.2672, lng: -97.7431 },
  };
  const plan = buildPlan(input({ existing: [earlier] }));
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.alreadyListed, ["k1"]);
});

test("a changed row replaces the one its own collection stopped listing", () => {
  const old: ExistingRow = {
    ...own("old-id"),
    provider: "AA",
    name: "Sunrise Group",
    day: 1,
    time: "07:00",
    location: { lat: 30.2672, lng: -97.7431 },
  };
  const plan = buildPlan(
    input({
      existing: [old],
      ownRows: [old],
      collections: [healthy],
      allowDeletes: true,
    }),
  );
  assert.deepEqual(
    plan.creates.map((row) => row.id),
    ["k1"],
  );
  assert.deepEqual(plan.deletes, ["old-id"]);
});

test("a row another collection still lists isn't deleted", () => {
  const moved = own("k1", "first-feed");
  const plan = buildPlan(
    input({
      sources: new Map([
        ["feed", source()],
        ["first-feed", source({ id: "first-feed" })],
      ]),
      existing: [moved],
      ownRows: [moved],
      collections: [healthy, { key: "first-feed", status: "ok", records: 3 }],
      allowDeletes: true,
    }),
  );
  assert.deepEqual(
    plan.refreshes.map((row) => row.id),
    ["k1"],
  );
  assert.deepEqual(plan.deletes, []);
});

test("a published meeting the verifier now rejects comes down", () => {
  const page = candidate({ origin: "page" });
  const plan = buildPlan(
    input({
      candidates: [page],
      verdicts: new Map([["k1", { verdict: "rejected", reason: "x" }]]),
      existing: [own("k1")],
      allowDeletes: true,
    }),
  );
  assert.deepEqual(plan.held["rejected-by-verifier"], ["k1"]);
  assert.deepEqual(plan.deletes, ["k1"]);
});

test("a confirmation doesn't carry over to a changed meeting", () => {
  const checked = candidate({ origin: "page", format: "Open" });
  const plan = buildPlan(
    input({
      candidates: [{ ...checked, format: "Changed afterward" }],
      verdicts: new Map([
        [
          "k1",
          {
            verdict: "confirmed",
            reason: "x",
            digest: candidateDigest(checked),
          },
        ],
      ]),
    }),
  );
  assert.deepEqual(plan.held.unverified, ["k1"]);
});

test("a feed row with a phishing link or contact details is held", () => {
  for (const over of [
    { link: "https://evil.example/join" },
    { name: "Call Dave 512-555-0142" },
    { city: "dave@example.org" },
    { format: "Ask 5125550142" },
  ]) {
    const plan = buildPlan(input({ candidates: [candidate(over)] }));
    assert.deepEqual(plan.creates, []);
    assert.deepEqual(plan.held["unsafe-content"], ["k1"]);
  }
});

test("a row that doesn't fit a stored shape is held", () => {
  const plan = buildPlan(
    input({ candidates: [candidate({ time: "7:00 PM" })] }),
  );
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.held["does-not-fit-shape"], ["k1"]);
});

test("each planned row carries both apps' shapes", () => {
  const row = buildPlan(input()).creates[0]!;
  assert.equal(row.apps.homegroups.day, "monday");
  assert.equal(row.apps.homegroups.addedBy, "system");
  assert.equal(row.apps.regroup.day, "monday");
  assert.equal(row.apps.regroup.onlineNotes, "");
});

test("our own row is refreshed", () => {
  const plan = buildPlan(
    input({ existing: [own("k1")], ownRows: [own("k1")] }),
  );
  assert.deepEqual(
    plan.refreshes.map((row) => row.id),
    ["k1"],
  );
});

test("deletes need the flag, a healthy feed, and a small share of rows", () => {
  const rows = [own("k1"), own("gone")];
  const base = { existing: [own("k1")], ownRows: rows };

  const noFlag = buildPlan(input({ ...base, collections: [healthy] }));
  assert.deepEqual(noFlag.deletes, []);
  assert.deepEqual(noFlag.wouldDelete, ["gone"]);

  const allowed = buildPlan(
    input({ ...base, collections: [healthy], allowDeletes: true }),
  );
  assert.deepEqual(allowed.deletes, ["gone"]);

  const failed = buildPlan(
    input({
      ...base,
      collections: [{ ...healthy, status: "failed" }],
      allowDeletes: true,
    }),
  );
  assert.deepEqual(failed.deletes, []);

  const notSwept = buildPlan(input({ ...base, allowDeletes: true }));
  assert.deepEqual(notSwept.deletes, []);

  const empty = buildPlan(
    input({
      ...base,
      collections: [{ ...healthy, records: 0 }],
      allowDeletes: true,
    }),
  );
  assert.deepEqual(empty.deletes, []);
});

test("an unusual drop blocks deletes for that collection", () => {
  const rows = Array.from({ length: 100 }, (_, i) => own(`r${i}`));
  const plan = buildPlan(
    input({
      candidates: [],
      ownRows: rows,
      collections: [healthy],
      allowDeletes: true,
    }),
  );
  assert.deepEqual(plan.deletes, []);
  assert.deepEqual(plan.blockedDeletes, [
    { collection: "feed", missing: 100, existing: 100 },
  ]);
});

test("a small collection may lose a few rows", () => {
  const rows = [own("a"), own("b"), own("c")];
  const plan = buildPlan(
    input({
      candidates: [],
      ownRows: rows,
      collections: [healthy],
      allowDeletes: true,
    }),
  );
  assert.equal(plan.deletes.length, 3);
});

test("a collection's rows are not judged by a source held back from publishing", () => {
  const plan = buildPlan(
    input({
      sources: new Map([["feed", source({ status: "proposed" })]]),
      ownRows: [own("gone")],
      collections: [healthy],
      allowDeletes: true,
    }),
  );
  assert.deepEqual(plan.deletes, []);
});
