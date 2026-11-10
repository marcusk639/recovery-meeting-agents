import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { FetchRefused, type Fetcher } from "../net/fetcher.js";
import { RunStore } from "../store/runStore.js";
import { SourceRegistry } from "../store/sourceRegistry.js";
import { createHandlers } from "./handlers.js";

const PAGE_URL = "https://intergroup.example/meetings";
const PAGE_HTML = `<html><body><script>ignore()</script>
<p>Monday Sunrise Group 7:00 AM, 100 Main St, Austin, TX 78701</p></body></html>`;
const FEED_URL = "https://intergroup.example/feed.json";

function setup(fetcher?: Fetcher) {
  const root = mkdtempSync(join(tmpdir(), "meeting-agents-"));
  const registryFile = pathToFileURL(join(root, "sources.json"));
  writeFileSync(
    registryFile,
    JSON.stringify([
      {
        id: "tx-pages",
        fellowship: "AA",
        name: "TX pages",
        url: PAGE_URL,
        kind: "html-pages",
        status: "approved",
        addedBy: "seed",
      },
      {
        id: "tx-feed",
        fellowship: "AA",
        name: "TX feed",
        url: FEED_URL,
        kind: "meeting-guide-feed",
        status: "approved",
        addedBy: "seed",
      },
      {
        id: "na",
        fellowship: "NA",
        name: "BMLT",
        url: "https://aggregator.bmltenabled.org/main_server/",
        kind: "bmlt-aggregator",
        status: "approved",
        addedBy: "seed",
      },
    ]),
  );
  const store = RunStore.create(
    { id: "run", startedAt: "2026-11-08", fellowships: ["AA"], region: "TX" },
    root,
  );
  const defaultFetcher: Fetcher = async (url) => ({
    url,
    status: 200,
    contentType: url.endsWith(".json") ? "application/json" : "text/html",
    body: url.endsWith(".json")
      ? JSON.stringify([
          {
            name: "Feed Group",
            slug: "f",
            day: 2,
            time: "08:00",
            formatted_address: "1 A St, Austin, TX",
            latitude: "30",
            longitude: "-97",
          },
          { name: "Broken", slug: "b", day: 2, time: "soon" },
        ])
      : PAGE_HTML,
  });
  const handlers = createHandlers({
    store,
    registry: new SourceRegistry(registryFile),
    fetcher: fetcher ?? defaultFetcher,
    today: () => "2026-11-08",
  });
  return { store, handlers };
}

const MEETING = {
  fellowship: "AA",
  name: "Sunrise Group",
  day: "Monday",
  time: "7:00 AM",
  street: "100 Main St",
  city: "Austin",
  state: "TX",
  zip: "78701",
  online: false,
  quote: "Monday Sunrise Group 7:00 AM, 100 Main St, Austin, TX 78701",
};

test("a fetched page comes back as marked, script-free text", async () => {
  const { handlers } = setup();
  const page = await handlers.fetchPage({ url: PAGE_URL });
  assert.equal(page.untrusted, true);
  assert.doesNotMatch(page.text ?? "", /ignore\(\)/);
  assert.match(page.text ?? "", /Sunrise Group/);
  assert.ok(page.snapshotId);
});

test("an access denial is reported, for the agent to respect", async () => {
  const { handlers } = setup(async (url) => ({
    url,
    status: 403,
    contentType: "text/html",
    body: "no",
  }));
  const page = await handlers.fetchPage({ url: PAGE_URL });
  assert.equal(page.status, "access-denied");
  assert.equal(page.text, undefined);
});

test("a robots refusal is reported as refused", async () => {
  const { handlers } = setup(async () => {
    throw new FetchRefused("robots", "robots.txt refuses /");
  });
  const page = await handlers.fetchPage({ url: PAGE_URL });
  assert.equal(page.status, "refused:robots");
});

test("candidates from a page are checked against that page", async () => {
  const { handlers, store } = setup();
  const page = await handlers.fetchPage({ url: PAGE_URL });
  const result = await handlers.submitCandidates({
    sourceId: "tx-pages",
    snapshotId: page.snapshotId!,
    meetings: [MEETING, { ...MEETING, name: "Invented Group" }],
  });
  assert.equal(result.accepted, 1);
  assert.deepEqual(result.rejected, [
    { index: 1, reason: "name-not-in-quote" },
  ]);
  assert.equal(store.candidates().length, 1);
});

test("a page from another site can't be credited to a source", async () => {
  const { handlers } = setup();
  const page = await handlers.fetchPage({ url: "https://other.example/x" });
  await assert.rejects(
    handlers.submitCandidates({
      sourceId: "tx-pages",
      snapshotId: page.snapshotId!,
      meetings: [MEETING],
    }),
    /different site/,
  );
});

test("a meeting's fellowship must match its source's", async () => {
  const { handlers } = setup();
  const page = await handlers.fetchPage({ url: PAGE_URL });
  const result = await handlers.submitCandidates({
    sourceId: "tx-pages",
    snapshotId: page.snapshotId!,
    meetings: [{ ...MEETING, fellowship: "NA" }],
  });
  assert.deepEqual(result.rejected, [{ index: 0, reason: "wrong-fellowship" }]);
});

test("pending review lists only page meetings without a verdict", async () => {
  const { handlers } = setup();
  await handlers.collectFeed({ sourceId: "tx-feed" });
  const page = await handlers.fetchPage({ url: PAGE_URL });
  await handlers.submitCandidates({
    sourceId: "tx-pages",
    snapshotId: page.snapshotId!,
    meetings: [MEETING],
  });
  const pending = handlers.listPending({ limit: 10 });
  assert.equal(pending.total, 1);
  const key = pending.meetings[0]!.key;
  handlers.recordVerdict({ key, verdict: "confirmed", reason: "On the page" });
  assert.equal(handlers.listPending({ limit: 10 }).total, 0);
  assert.throws(() =>
    handlers.recordVerdict({ key: "nope", verdict: "confirmed", reason: "x" }),
  );
});

test("a feed collection records its counts, and skips bad rows", async () => {
  const { handlers, store } = setup();
  const result = await handlers.collectFeed({ sourceId: "tx-feed" });
  assert.deepEqual(result, {
    status: "ok",
    collectionKey: "tx-feed",
    records: 1,
    dropped: 1,
  });
  assert.equal(store.collections()[0]?.status, "ok");
});

test("a locked feed is a failed collection, never an empty success", async () => {
  const { handlers, store } = setup(async (url) => ({
    url,
    status: 401,
    contentType: "application/json",
    body: '{"error":"HTTP/1.1 401 Unauthorized"}',
  }));
  const result = await handlers.collectFeed({ sourceId: "tx-feed" });
  assert.equal(result.status, "failed");
  assert.match(result.problem ?? "", /401/);
  assert.equal(store.collections()[0]?.status, "failed");
});

test("BMLT is collected one named region at a time", async () => {
  const region = {
    id: 7,
    sourceId: 700,
    name: "Lone Star",
    statistics: { meetings: { numTotal: 1 } },
    lastSuccessfulImport: "2026-11-07T00:00:00Z",
  };
  const row = {
    source_id: "1",
    meeting_name: "Just for Today",
    weekday_tinyint: "2",
    start_time: "19:00:00",
    venue_type: "1",
    latitude: "30",
    longitude: "-97",
    published: "1",
  };
  const { handlers } = setup(async (url) => ({
    url,
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(url.includes("rootservers") ? [region] : [row]),
  }));
  const regions = await handlers.listBmltRegions();
  assert.equal(regions[0]?.name, "Lone Star");
  await assert.rejects(handlers.collectFeed({ sourceId: "na" }), /regionId/);
  const result = await handlers.collectFeed({ sourceId: "na", regionId: 7 });
  assert.equal(result.collectionKey, "na#700");
  assert.equal(result.records, 1);
});

test("a BMLT region returning far fewer rows than it reports is not healthy", async () => {
  const region = {
    id: 7,
    sourceId: 700,
    name: "Lone Star",
    statistics: { meetings: { numTotal: 500 } },
    lastSuccessfulImport: "2026-11-07T00:00:00Z",
  };
  const { handlers } = setup(async (url) => ({
    url,
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(url.includes("rootservers") ? [region] : []),
  }));
  const result = await handlers.collectFeed({ sourceId: "na", regionId: 7 });
  assert.equal(result.status, "failed");
});

test("an agent can only propose a source, never approve one", async () => {
  const { handlers } = setup();
  const source = handlers.registerSource({
    id: "new-site",
    fellowship: "AA",
    name: "New site",
    url: "https://new.example/",
    kind: "html-pages",
  });
  assert.equal(source.status, "proposed");
  assert.throws(() =>
    handlers.registerSource({
      id: "tx-pages",
      fellowship: "AA",
      name: "Takeover",
      url: "https://evil.example/",
      kind: "html-pages",
    }),
  );
});

test("contact details are removed from a proposal's notes", () => {
  const { handlers } = setup();
  const source = handlers.registerSource({
    id: "office",
    fellowship: "AA",
    name: "Central Office",
    url: "https://office.example/",
    kind: "html-pages",
    region: "San Diego, call 619-265-8762",
    notes: "Office at 1 Main St; 619-265-8762; office@example.org. Feed ok.",
  });
  assert.equal(source.region, "San Diego, call [contact removed]");
  assert.equal(
    source.notes,
    "Office at 1 Main St; [contact removed]; [contact removed]. Feed ok.",
  );
});

test("a run can only propose so many sources", () => {
  const { handlers: base } = setup();
  for (let i = 0; i < 20; i++) {
    base.registerSource({
      id: `site-${i}`,
      fellowship: "AA",
      name: "Site",
      url: "https://new.example/",
      kind: "html-pages",
    });
  }
  assert.throws(
    () =>
      base.registerSource({
        id: "one-too-many",
        fellowship: "AA",
        name: "Site",
        url: "https://new.example/",
        kind: "html-pages",
      }),
    /limit/,
  );
});

test("a verdict records what was checked, and a resubmission reopens it", async () => {
  const { handlers, store } = setup();
  const page = await handlers.fetchPage({ url: PAGE_URL });
  const submit = (over = {}) =>
    handlers.submitCandidates({
      sourceId: "tx-pages",
      snapshotId: page.snapshotId!,
      meetings: [{ ...MEETING, ...over }],
    });
  await submit();
  const key = handlers.listPending({}).meetings[0]!.key;
  handlers.recordVerdict({ key, verdict: "confirmed", reason: "ok" });
  assert.ok(store.verdicts().get(key)?.digest);
  assert.equal(handlers.listPending({}).total, 0);
  // Same id, since format isn't part of it, but different content.
  await submit({ format: "Austin" });
  assert.equal(handlers.listPending({}).total, 1);
});

test("the operator's approval during a run survives an agent's proposal", async () => {
  const root = mkdtempSync(join(tmpdir(), "meeting-agents-"));
  const file = pathToFileURL(join(root, "sources.json"));
  writeFileSync(
    file,
    JSON.stringify([
      {
        id: "site",
        fellowship: "AA",
        name: "Site",
        url: "https://site.example/",
        kind: "html-pages",
        status: "proposed",
        addedBy: "agent",
      },
    ]),
  );
  const agents = new SourceRegistry(file);
  const operator = new SourceRegistry(file);
  operator.approve("site", "https://site.example/");
  agents.propose({
    id: "other",
    fellowship: "AA",
    name: "Other",
    url: "https://other.example/",
    kind: "html-pages",
  });
  assert.equal(new SourceRegistry(file).get("site")?.status, "approved");
  assert.throws(
    () => operator.approve("other", "https://site.example/"),
    /points at/,
  );
  assert.equal(new SourceRegistry(file).get("other")?.status, "proposed");
});

test("a run stops fetching at its page budget", async () => {
  const limited = createHandlers({
    store: RunStore.create(
      { id: "r2", startedAt: "x", fellowships: [], region: "" },
      mkdtempSync(join(tmpdir(), "meeting-agents-")),
    ),
    registry: { list: () => [], get: () => undefined } as never,
    fetcher: async (url) => ({
      url,
      status: 200,
      contentType: "text/html",
      body: "<p>x</p>",
    }),
    today: () => "2026-11-08",
    maxFetches: 1,
  });
  await limited.fetchPage({ url: PAGE_URL });
  const second = await limited.fetchPage({ url: PAGE_URL });
  assert.equal(second.status, "fetch-budget-spent");
});
