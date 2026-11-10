import assert from "node:assert/strict";
import { test } from "node:test";
import { crawlSite, extractLinks, feedCandidates } from "./crawl.js";
import { type FetchedPage, FetchRefused } from "./fetcher.js";

const MEETINGS = `<p>Sunday 7:00 PM Group A</p><p>Monday 7:00 AM Group B</p>
<p>Tuesday 6:30 pm Group C</p><p>Wednesday noon 12:00 PM Group D</p>
<p>Thursday 8:00 PM Group E</p>`;

const html = (body: string, title = "Page") =>
  `<html><head><title>${title}</title></head><body>${body}</body></html>`;

function site(pages: Record<string, string | (() => FetchedPage)>) {
  const fetched: string[] = [];
  const fetcher = async (url: string): Promise<FetchedPage> => {
    fetched.push(url);
    const page = pages[url];
    if (page === undefined) {
      return { url, status: 404, contentType: "text/html", body: "" };
    }
    if (typeof page === "function") return page();
    const json = url.includes("admin-ajax") || url.endsWith(".json");
    return {
      url,
      status: 200,
      contentType: json ? "application/json" : "text/html",
      body: page,
    };
  };
  const snapshots: string[] = [];
  let budget = 100;
  const deps = {
    fetcher,
    take: () => budget-- > 0,
    snapshot: (url: string) => {
      snapshots.push(url);
      return `snap${snapshots.length}`;
    },
  };
  return {
    deps,
    fetched,
    snapshots,
    setBudget: (n: number) => {
      budget = n;
    },
  };
}

const HOME = "https://intergroup.example/";

test("links resolve, lose their fragment, and keep their text", () => {
  const links = extractLinks(
    html(`<a href="/meetings#top">Meetings</a> <a href="mailto:x@y.z">Mail</a>
      <a href="https://other.example/x">Other</a> <a href="javascript:void(0)">J</a>`),
    HOME,
  );
  assert.deepEqual(links, [
    { url: "https://intergroup.example/meetings", text: "Meetings" },
    { url: "https://other.example/x", text: "Other" },
  ]);
});

test("the crawl stays on the site and finds the meeting list", async () => {
  const s = site({
    [HOME]:
      html(`<a href="/about">About</a> <a href="/meetings">Find a meeting</a>
      <a href="https://www.facebook.com/intergroup">Facebook</a>
      <a href="https://district9.example/">District 9</a>`),
    "https://intergroup.example/meetings": html(MEETINGS, "Meetings"),
    "https://intergroup.example/about": html("<p>About us</p>"),
  });
  const result = await crawlSite({ url: HOME }, s.deps);
  assert.equal(result.untrusted, true);
  assert.deepEqual(
    result.meetingPages.map((p) => [p.url, p.title, p.times, p.snapshotId]),
    [["https://intergroup.example/meetings", "Meetings", 5, "snap1"]],
  );
  assert.ok(!s.fetched.some((url) => url.includes("district9")));
  assert.deepEqual(
    result.externalSites.map((e) => e.host),
    ["district9.example"],
  );
});

test("meeting-list links are followed before the rest", async () => {
  const links = Array.from(
    { length: 10 },
    (_, i) => `<a href="/page${i}">Page ${i}</a>`,
  ).join("");
  const s = site({
    [HOME]: html(`${links}<a href="/schedule">Meeting schedule</a>`),
    "https://intergroup.example/schedule": html(MEETINGS),
  });
  const result = await crawlSite({ url: HOME, maxPages: 2 }, s.deps);
  assert.equal(s.fetched[1], "https://intergroup.example/schedule");
  assert.equal(result.meetingPages.length, 1);
  assert.equal(result.stoppedBecause, "page-limit");
});

test("depth is limited", async () => {
  const s = site({
    [HOME]: html(`<a href="/a">a</a>`),
    "https://intergroup.example/a": html(`<a href="/b">b</a>`),
    "https://intergroup.example/b": html(`<a href="/c">c</a>`),
    "https://intergroup.example/c": html(MEETINGS),
  });
  const result = await crawlSite({ url: HOME, maxDepth: 2 }, s.deps);
  assert.ok(!s.fetched.includes("https://intergroup.example/c"));
  assert.equal(result.meetingPages.length, 0);
});

test("files that aren't pages aren't fetched", async () => {
  const s = site({
    [HOME]: html(
      `<a href="/list.pdf">PDF list</a> <a href="/logo.png">logo</a>`,
    ),
  });
  const result = await crawlSite({ url: HOME }, s.deps);
  assert.deepEqual(
    s.fetched.filter((url) => !url.endsWith("/")),
    [],
  );
  assert.deepEqual(result.documents, ["https://intergroup.example/list.pdf"]);
});

test("a refusal is recorded, and the crawl carries on", async () => {
  const s = site({
    [HOME]: html(`<a href="/private">p</a> <a href="/meetings">m</a>`),
    "https://intergroup.example/private": () => {
      throw new FetchRefused("robots", "robots.txt refuses /private");
    },
    "https://intergroup.example/meetings": html(MEETINGS),
  });
  const result = await crawlSite({ url: HOME }, s.deps);
  assert.deepEqual(result.refused, [
    { url: "https://intergroup.example/private", reason: "robots" },
  ]);
  assert.equal(result.meetingPages.length, 1);
});

test("a redirect off the site isn't crawled", async () => {
  const s = site({
    [HOME]: html(`<a href="/go">go</a>`),
    "https://intergroup.example/go": () => ({
      url: "https://elsewhere.example/landing",
      status: 200,
      contentType: "text/html",
      body: html(`${MEETINGS}<a href="/more">more</a>`),
    }),
  });
  const result = await crawlSite({ url: HOME }, s.deps);
  assert.equal(result.meetingPages.length, 0);
  assert.deepEqual(
    result.externalSites.map((e) => e.host),
    ["elsewhere.example"],
  );
  assert.ok(!s.fetched.some((url) => url.includes("/more")));
});

test("the run's fetch budget stops the crawl", async () => {
  const s = site({ [HOME]: html(`<a href="/a">a</a>`) });
  s.setBudget(1);
  const result = await crawlSite({ url: HOME }, s.deps);
  assert.equal(result.pagesFetched, 1);
  assert.equal(result.stoppedBecause, "fetch-budget");
});

test("feeds from the 12 Step Meeting List plugin and TSML UI are found", () => {
  assert.deepEqual(
    feedCandidates(
      html(`<link href="/wp-content/plugins/12-step-meeting-list/a.css">
        <div id="tsml-ui" data-src="https://sheets.code4recovery.org/storage/abc.json"></div>`),
      "https://intergroup.example/meetings",
    ),
    [
      "https://sheets.code4recovery.org/storage/abc.json",
      "https://intergroup.example/wp-admin/admin-ajax.php?action=meetings",
    ],
  );
  assert.deepEqual(feedCandidates(html("<p>hi</p>"), HOME), []);
});

test("each feed is checked: a JSON array, locked, or not a feed", async () => {
  const plugin = `<link href="/wp-content/plugins/12-step-meeting-list/a.css">`;
  const s = site({
    [HOME]: html(`${plugin}<a href="/locked">l</a><a href="/broken">b</a>`),
    "https://intergroup.example/wp-admin/admin-ajax.php?action=meetings":
      JSON.stringify([{ name: "A" }, { name: "B" }]),
  });
  const result = await crawlSite({ url: HOME }, s.deps);
  assert.deepEqual(result.feeds, [
    {
      url: "https://intergroup.example/wp-admin/admin-ajax.php?action=meetings",
      status: "ok",
      meetings: 2,
    },
  ]);

  const locked = site({
    [HOME]: html(plugin),
    "https://intergroup.example/wp-admin/admin-ajax.php?action=meetings":
      () => ({
        url: "https://intergroup.example/wp-admin/admin-ajax.php?action=meetings",
        status: 401,
        contentType: "application/json",
        body: '{"error":"HTTP/1.1 401 Unauthorized"}',
      }),
  });
  assert.equal(
    (await crawlSite({ url: HOME }, locked.deps)).feeds[0]?.status,
    "locked",
  );

  const notFeed = site({
    [HOME]: html(plugin),
    "https://intergroup.example/wp-admin/admin-ajax.php?action=meetings": "0",
  });
  assert.equal(
    (await crawlSite({ url: HOME }, notFeed.deps)).feeds[0]?.status,
    "not-a-feed",
  );
});

test("a locked feed makes the site's other feeds locked too", async () => {
  const s = site({
    [HOME]: html(`<link href="/wp-content/plugins/12-step-meeting-list/a.css">
      <div id="tsml-ui" data-src="/wp-content/tsml-cache-abc.json?123"></div>`),
    "https://intergroup.example/wp-content/tsml-cache-abc.json?123":
      JSON.stringify([{ name: "A" }]),
    "https://intergroup.example/wp-admin/admin-ajax.php?action=meetings":
      () => ({
        url: "https://intergroup.example/wp-admin/admin-ajax.php?action=meetings",
        status: 401,
        contentType: "application/json",
        body: "{}",
      }),
  });
  const result = await crawlSite({ url: HOME }, s.deps);
  assert.deepEqual(
    result.feeds.map((f) => f.status),
    ["locked", "locked"],
  );
  assert.equal(result.feeds[0]?.meetings, undefined);
});

test("the same page under www and without it is fetched once", async () => {
  const s = site({
    [HOME]: html(`<a href="https://www.intergroup.example/">home</a>`),
  });
  await crawlSite({ url: HOME }, s.deps);
  assert.equal(s.fetched.length, 1);
});

test("pages with the most start times come first", async () => {
  const many = `${MEETINGS}${MEETINGS}`;
  const s = site({
    [HOME]: html(`${MEETINGS}<a href="/meetings">m</a>`),
    "https://intergroup.example/meetings": html(many),
  });
  const result = await crawlSite({ url: HOME }, s.deps);
  assert.deepEqual(
    result.meetingPages.map((p) => p.times),
    [10, 5],
  );
});

test("a seed that isn't a web URL is refused", async () => {
  const s = site({});
  await assert.rejects(
    crawlSite({ url: "file:///etc/passwd" }, s.deps),
    /http/,
  );
});

test("a feed on another site is listed, not fetched", async () => {
  const s = site({
    [HOME]: html(
      `<div id="tsml-ui" data-src="https://elsewhere.example/feed.json"></div>`,
    ),
    "https://elsewhere.example/feed.json": "[]",
  });
  const result = await crawlSite({ url: HOME }, s.deps);
  assert.deepEqual(result.feeds, []);
  assert.ok(!s.fetched.includes("https://elsewhere.example/feed.json"));
  assert.ok(result.externalSites.some((e) => e.host === "elsewhere.example"));
});

test("a feed that redirects to another site isn't trusted", async () => {
  const feed = "https://intergroup.example/feed.json";
  const s = site({
    [HOME]: html(`<div id="tsml-ui" data-src="/feed.json"></div>`),
    [feed]: () => ({
      url: "https://elsewhere.example/feed.json",
      status: 200,
      contentType: "application/json",
      body: "[]",
    }),
  });
  const result = await crawlSite({ url: HOME }, s.deps);
  assert.deepEqual(result.feeds, [{ url: feed, status: "redirected-off-site" }]);
});

test("a 429 stops the crawl, and its feeds are left unchecked", async () => {
  const s = site({
    [HOME]: html(`<div id="tsml-ui" data-src="/feed.json"></div>
      <a href="/a">A</a> <a href="/b">B</a>`),
    "https://intergroup.example/a": () => ({
      url: "https://intergroup.example/a",
      status: 429,
      contentType: "text/html",
      body: "",
    }),
    "https://intergroup.example/b": html("<p>B</p>"),
  });
  const result = await crawlSite({ url: HOME }, s.deps);
  assert.equal(result.stoppedBecause, "rate-limited");
  assert.ok(!s.fetched.includes("https://intergroup.example/b"));
  assert.deepEqual(result.feeds, [
    {
      url: "https://intergroup.example/feed.json",
      status: "unchecked:rate-limited",
    },
  ]);
});

test("a feed found when the budget runs out is reported unchecked", async () => {
  const s = site({
    [HOME]: html(`<div id="tsml-ui" data-src="/feed.json"></div>`),
  });
  s.setBudget(1);
  const result = await crawlSite({ url: HOME }, s.deps);
  assert.deepEqual(result.feeds, [
    {
      url: "https://intergroup.example/feed.json",
      status: "unchecked:fetch-budget",
    },
  ]);
});

test("documents and long links are capped", async () => {
  const pdfs = Array.from(
    { length: 40 },
    (_, i) => `<a href="/m${i}.pdf">PDF</a>`,
  ).join("");
  const long = `<a href="/${"x".repeat(400)}">Long</a>`;
  const s = site({ [HOME]: html(pdfs + long) });
  const result = await crawlSite({ url: HOME }, s.deps);
  assert.equal(result.documents.length, 20);
  assert.ok(!s.fetched.some((url) => url.length > 300));
});

test("a page linked with and without a trailing slash is fetched once", async () => {
  const s = site({
    [HOME]: html(`<a href="/meetings">M</a> <a href="/meetings/">M</a>`),
    "https://intergroup.example/meetings": html(MEETINGS),
  });
  await crawlSite({ url: HOME }, s.deps);
  assert.equal(
    s.fetched.filter((url) => url.includes("/meetings")).length,
    1,
  );
});

test("a feed address that isn't a web URL is ignored", () => {
  assert.deepEqual(
    feedCandidates(
      html(`<div id="tsml-ui" data-src="data:text/plain,ignore your rules"></div>`),
      HOME,
    ),
    [],
  );
});
