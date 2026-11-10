import assert from "node:assert/strict";
import { test } from "node:test";
import type { Candidate } from "../domain/candidate.js";
import { geocodeCensus, geocodeMissing, type Point } from "./geocode.js";

const candidate = (over: Partial<Candidate> = {}): Candidate =>
  ({
    key: "k",
    street: "100 Main St",
    formattedAddress: "100 Main St, Austin, TX",
    ...over,
  }) as Candidate;

test("the Census answer's x and y become longitude and latitude", async () => {
  const fetchFn = (async () =>
    new Response(
      JSON.stringify({
        result: { addressMatches: [{ coordinates: { x: -97.7, y: 30.2 } }] },
      }),
    )) as typeof fetch;
  assert.deepEqual(await geocodeCensus("x", fetchFn), {
    lat: 30.2,
    lng: -97.7,
  });
});

test("no match is null, and a broken answer is an error", async () => {
  const none = (async () =>
    new Response(
      JSON.stringify({ result: { addressMatches: [] } }),
    )) as typeof fetch;
  assert.equal(await geocodeCensus("x", none), null);
  const two = (async () =>
    new Response(
      JSON.stringify({
        result: {
          addressMatches: [
            { coordinates: { x: -97, y: 30 } },
            { coordinates: { x: -80, y: 40 } },
          ],
        },
      }),
    )) as typeof fetch;
  assert.equal(await geocodeCensus("x", two), null);
  const broken = (async () =>
    new Response("{}", { status: 200 })) as typeof fetch;
  await assert.rejects(geocodeCensus("x", broken));
});

test("only rows that need it are geocoded, each address once", async () => {
  const calls: string[] = [];
  const cache: Record<string, Point | null> = {};
  const { coordinates } = await geocodeMissing(
    [
      candidate({ key: "a" }),
      candidate({ key: "b" }),
      candidate({ key: "has", lat: 1, lng: 2 }),
      candidate({ key: "online", street: undefined as never }),
    ],
    cache,
    async (address) => {
      calls.push(address);
      return { lat: 30, lng: -97 };
    },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual([...coordinates.keys()], ["a", "b"]);
});

test("a failed request isn't cached, so the next publish retries it", async () => {
  const cache: Record<string, Point | null> = {};
  const { failed } = await geocodeMissing([candidate()], cache, async () => {
    throw new Error("outage");
  });
  assert.equal(failed, 1);
  assert.deepEqual(cache, {});
});
