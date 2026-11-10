import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  directoryGeohash,
  directoryMeetingId,
  GEOHASH_PRECISION,
} from "./identity.js";

const PLATFORM = fileURLToPath(
  new URL("../../../recovery-platform", import.meta.url),
);
const UPSTREAM = "recovery-api/src/lib/meetings/identity.ts";

// Produced by running recovery-platform's own identity.ts on these inputs.
const GOLDEN = [
  {
    input: {
      name: "Sunrise Group",
      day: 1,
      time: "07:00",
      link: "",
      formattedAddress: "100 Main St, Austin, TX 78701, USA",
    },
    id: "51ecf2a7d578e89b8c587b5e",
  },
  {
    input: {
      name: "Sunrise Group",
      day: "Monday",
      time: "7:00 AM",
      link: "",
      formattedAddress: "100 Main St, Austin, TX 78701, USA",
    },
    id: "51ecf2a7d578e89b8c587b5e",
  },
  {
    input: {
      name: "Serenity Now",
      day: 6,
      time: "18:30:00",
      link: "https://zoom.us/j/999",
    },
    id: "cab9993cc03559c454663f00",
  },
];

test("ids match the ones recovery-api computes", () => {
  for (const { input, id } of GOLDEN) {
    assert.equal(directoryMeetingId(input), id);
  }
});

test("the geohash matches recovery-api's frozen precision", () => {
  assert.equal(GEOHASH_PRECISION, 10);
  assert.equal(directoryGeohash(30.2672, -97.7431), "9v6kpvcxhx");
});

/** Prettier may restyle the copy; only a change to what it says counts as drift. */
const normalized = (source: string) =>
  source
    .replace(/"/g, "'")
    .replace(/,(\s*[)\]}])/g, "$1")
    .replace(/\s+/g, "");

test(
  "the copy has not drifted from recovery-platform's origin/main",
  {
    skip: !existsSync(PLATFORM) && "recovery-platform is not checked out here",
  },
  () => {
    const upstream = execFileSync(
      "git",
      ["-C", PLATFORM, "show", `origin/main:${UPSTREAM}`],
      { encoding: "utf8" },
    );
    // The copy's one addition is a @ts-nocheck first line, because this repo's
    // stricter tsconfig (noUncheckedIndexedAccess) rejects upstream's indexing.
    const local = readFileSync(
      new URL("./identity.ts", import.meta.url),
      "utf8",
    ).replace(/^\/\/ @ts-nocheck[^\n]*\n/, "");
    assert.equal(normalized(local), normalized(upstream));
  },
);
