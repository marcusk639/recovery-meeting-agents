import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  APP_MEETING_TYPES,
  DirectoryRow,
  HomegroupsMeeting,
  RegroupMeeting,
} from "./shapes.js";

const PLATFORM = fileURLToPath(
  new URL("../../../recovery-platform", import.meta.url),
);
const skip =
  !existsSync(PLATFORM) && "recovery-platform is not checked out here";

const upstream = (path: string) =>
  execFileSync("git", ["-C", PLATFORM, "show", `origin/main:${path}`], {
    encoding: "utf8",
  });

/** The field names declared directly in one class or interface body. */
function fieldsOf(source: string, opening: string): string[] {
  const start = source.indexOf(opening);
  assert.notEqual(start, -1, `${opening} not found upstream`);
  const end = source.indexOf("\n}", start);
  const body = source
    .slice(start + opening.length, end)
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return [...body.matchAll(/^\s{2}(\w+)\??\s*[:=]/gm)].map(
    (match) => match[1]!,
  );
}

/** Fields this repo deliberately leaves unset, each with the reason. */
const NOT_OURS = {
  directory: {
    id: "the document's key",
    createdByApp: "only on source:'app' rows",
    createdByUid: "only on source:'app' rows",
    lastRefreshedAt: "a timestamp the writer sets",
    lastSeenAt: "a timestamp the writer sets",
    createdAt: "a timestamp the writer sets",
    updatedAt: "a timestamp the writer sets",
  },
  homegroups: {
    notes: "free text that can hold names and phone numbers",
    locationNotes: "free text that can hold names and phone numbers",
    groupName: "owned by a Homegroups group",
    district: "owned by a Homegroups group",
    venmo: "owned by a Homegroups group",
    square: "owned by a Homegroups group",
    paypal: "owned by a Homegroups group",
    groupId: "owned by a Homegroups group",
    createdAt: "a timestamp the writer sets",
    updatedAt: "a timestamp the writer sets",
  },
  regroup: {
    Location: "legacy NA address lines, which the list no longer needs",
  },
};

function assertCovered(
  upstreamFields: string[],
  schema: { shape: Record<string, unknown> },
  ignored: Record<string, string>,
): void {
  assert.ok(upstreamFields.length > 3, "the upstream parse found no fields");
  const known = new Set([
    ...Object.keys(schema.shape),
    ...Object.keys(ignored),
  ]);
  const unknown = upstreamFields.filter((field) => !known.has(field));
  assert.deepEqual(
    unknown,
    [],
    "An upstream type gained a field. Add it to shapes.ts, or to NOT_OURS with a reason.",
  );
}

test(
  "recovery-api's DirectoryMeeting has no field this repo hasn't considered",
  { skip },
  () => {
    const source = upstream("recovery-api/src/entities/DirectoryMeeting.ts");
    assertCovered(
      fieldsOf(source, "export interface DirectoryMeeting {"),
      DirectoryRow,
      NOT_OURS.directory,
    );
    assertCovered(
      fieldsOf(source, "export interface DirectoryLocation {"),
      DirectoryRow.shape.location,
      {},
    );
  },
);

test(
  "Homegroups' Meeting has no field this repo hasn't considered",
  { skip },
  () => {
    assertCovered(
      fieldsOf(
        upstream("homegroups/functions/src/entities/Meeting.ts"),
        "export class Meeting {",
      ),
      HomegroupsMeeting,
      NOT_OURS.homegroups,
    );
  },
);

test(
  "Regroup's RatsMeeting has no field this repo hasn't considered",
  { skip },
  () => {
    assertCovered(
      fieldsOf(
        upstream("regroup/functions/src/entities/Meeting.ts"),
        "export class RatsMeeting {",
      ),
      RegroupMeeting,
      NOT_OURS.regroup,
    );
  },
);

test(
  "both apps still accept the meeting types this repo writes",
  { skip },
  () => {
    for (const path of [
      "homegroups/functions/src/entities/Meeting.ts",
      "regroup/functions/src/entities/Meeting.ts",
    ]) {
      const source = upstream(path);
      for (const type of APP_MEETING_TYPES) {
        assert.match(source, new RegExp(`"${type}"`), `${path} lost ${type}`);
      }
    }
  },
);

test(
  "the directory still accepts the providers this repo writes",
  { skip },
  () => {
    const source = upstream("recovery-api/src/entities/DirectoryMeeting.ts");
    for (const provider of DirectoryRow.shape.provider.options) {
      assert.match(source, new RegExp(`'${provider}'`));
    }
  },
);
