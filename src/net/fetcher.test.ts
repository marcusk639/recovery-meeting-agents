import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFetcher,
  FetchRefused,
  guardedLookup,
  isPublicAddress,
} from "./fetcher.js";

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

function server(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const fetcher = (fetchFn: typeof fetch, lookup = publicDns) =>
  createFetcher({ fetchFn, lookup, minIntervalMs: 0 });

test("private and metadata addresses are not public", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.8",
    "172.16.4.2",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:10.0.0.1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("a host that resolves to a private address is refused", async () => {
  const { fetchFn, calls } = server({});
  const get = fetcher(fetchFn, async () => [
    { address: "10.0.0.1", family: 4 },
  ]);
  await assert.rejects(
    get("https://internal.example/x"),
    (e: FetchRefused) => e.reason === "private-address",
  );
  assert.deepEqual(calls, []);
});

test("non-web schemes, odd ports and credentials are refused", async () => {
  const { fetchFn } = server({});
  const get = fetcher(fetchFn);
  for (const url of [
    "file:///etc/passwd",
    "https://example.org:8443/x",
    "https://user:pw@example.org/x",
  ]) {
    await assert.rejects(
      get(url),
      (e: FetchRefused) => e.reason === "bad-url",
      url,
    );
  }
});

test("robots.txt is honored", async () => {
  const { fetchFn, calls } = server({
    "https://example.org/robots.txt": () =>
      new Response("User-agent: *\nDisallow: /private/"),
    "https://example.org/open": () => new Response("hello"),
  });
  const get = fetcher(fetchFn);
  await assert.rejects(
    get("https://example.org/private/x"),
    (e: FetchRefused) => e.reason === "robots",
  );
  const page = await get("https://example.org/open");
  assert.equal(page.body, "hello");
  assert.equal(
    calls.filter((url) => url.endsWith("robots.txt")).length,
    1,
    "robots.txt is cached per origin",
  );
});

test("a site that refuses robots.txt is treated as refusing crawlers", async () => {
  const { fetchFn } = server({
    "https://example.org/robots.txt": () => new Response("no", { status: 403 }),
  });
  await assert.rejects(
    fetcher(fetchFn)("https://example.org/x"),
    (e: FetchRefused) => e.reason === "robots",
  );
});

test("the connection itself refuses a host that changed its answer", async () => {
  const lookup = guardedLookup(((
    host: string,
    _options: object,
    callback: (e: Error | null, a?: unknown, f?: number) => void,
  ) =>
    host === "single.example"
      ? callback(null, "169.254.169.254", 4)
      : host === "all.example"
        ? callback(null, [
            { address: "93.184.216.34", family: 4 },
            { address: "127.0.0.1", family: 4 },
          ])
        : callback(null, "93.184.216.34", 4)) as never);
  const run = (host: string) =>
    new Promise<Error | null>((resolve) =>
      lookup(host, {}, (error) => resolve(error)),
    );
  assert.ok(await run("single.example"));
  assert.ok(await run("all.example"));
  assert.equal(await run("public.example"), null);
});

test("IPv6 ranges that wrap an IPv4 address aren't public", () => {
  assert.equal(isPublicAddress("64:ff9b::7f00:1"), false);
  assert.equal(isPublicAddress("2002:7f00:1::"), false);
});

test("a redirected robots.txt still applies", async () => {
  const { fetchFn } = server({
    "https://example.org/robots.txt": () =>
      new Response(null, {
        status: 301,
        headers: { location: "https://www.example.org/robots.txt" },
      }),
    "https://www.example.org/robots.txt": () =>
      new Response("User-agent: *\nDisallow: /private/"),
    "https://example.org/open": () => new Response("hello"),
  });
  const get = fetcher(fetchFn);
  await assert.rejects(
    get("https://example.org/private/x"),
    (e: FetchRefused) => e.reason === "robots",
  );
  assert.equal((await get("https://example.org/open")).body, "hello");
});

test("a rate-limited robots.txt means no crawling", async () => {
  const { fetchFn } = server({
    "https://example.org/robots.txt": () =>
      new Response("slow down", { status: 429 }),
  });
  await assert.rejects(
    fetcher(fetchFn)("https://example.org/x"),
    (e: FetchRefused) => e.reason === "robots",
  );
});

test("a redirect to a private address is refused", async () => {
  const lookup = async (host: string) => [
    host === "internal.example"
      ? { address: "169.254.169.254", family: 4 }
      : { address: "93.184.216.34", family: 4 },
  ];
  const { fetchFn } = server({
    "https://example.org/x": () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://internal.example/latest" },
      }),
  });
  await assert.rejects(
    createFetcher({ fetchFn, lookup, minIntervalMs: 0 })(
      "https://example.org/x",
    ),
    (e: FetchRefused) => e.reason === "private-address",
  );
});

test("access denials come back as a status for the caller to respect", async () => {
  const { fetchFn } = server({
    "https://example.org/feed": () => new Response("no", { status: 401 }),
  });
  const page = await fetcher(fetchFn)("https://example.org/feed");
  assert.equal(page.status, 401);
});

test("an oversized body is refused rather than held in memory", async () => {
  const { fetchFn } = server({
    "https://example.org/big": () => new Response("x".repeat(2048)),
  });
  const get = createFetcher({
    fetchFn,
    lookup: publicDns,
    minIntervalMs: 0,
    maxBytes: 1024,
  });
  await assert.rejects(
    get("https://example.org/big"),
    (e: FetchRefused) => e.reason === "too-large",
  );
});
