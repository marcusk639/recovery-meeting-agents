import assert from "node:assert/strict";
import { test } from "node:test";
import type { Candidate } from "./candidate.js";
import {
  homegroupsMeetingId,
  toDirectoryRow,
  toHomegroupsMeeting,
  toRegroupMeeting,
  toShapes,
} from "./toShapes.js";

const POINT = { lat: 30.2672, lng: -97.7431 };

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  key: "51ecf2a7d578e89b8c587b5e",
  origin: "feed",
  sourceId: "feed",
  collectionKey: "feed",
  sourceUrl: "https://intergroup.example/feed.json",
  dataAsOf: "2026-11-08",
  fellowship: "AA",
  name: "Sunrise Group",
  day: 4,
  time: "19:00",
  street: "100 Main St",
  city: "Austin",
  state: "TX",
  zip: "78701",
  formattedAddress: "100 Main St, Austin, TX 78701, USA",
  online: false,
  type: "Big Book,Closed,English",
  format: "Big Book,Closed,English",
  country: "US",
  locationName: "First Church",
  externalId: "1450707",
  ...over,
});

test("the directory row holds a day name and a nested location", () => {
  const row = toDirectoryRow(candidate(), POINT);
  assert.ok(row.success);
  assert.equal(row.data.day, "thursday");
  assert.equal(row.data.provider, "AA");
  assert.equal(row.data.source, "external");
  assert.equal(row.data.location.address, "100 Main St");
  assert.equal(row.data.location.geohash.length, 10);
  assert.equal(row.data.dataAsOf, "2026-11-08");
});

test("Celebrate Recovery keeps the directory's provider value", () => {
  const row = toDirectoryRow(
    candidate({ fellowship: "CELEBRATE_RECOVERY" }),
    POINT,
  );
  assert.ok(row.success);
  assert.equal(row.data.provider, "CELEBRATE_RECOVERY");
});

test("the Homegroups document matches what its stored rows hold", () => {
  const meeting = toHomegroupsMeeting(candidate(), POINT);
  assert.ok(meeting.success);
  const { data } = meeting;
  // From a real stored document: day is a weekday name, not "0"-"6".
  assert.equal(data.day, "thursday");
  assert.equal(data.time, "19:00");
  assert.equal(data.type, "AA");
  assert.equal(data.verified, true);
  assert.equal(data.addedBy, "system");
  assert.equal(data.types, "Big Book,Closed,English");
  assert.equal(data.format, "Big Book,Closed,English");
  // Full address in `address`, street alone in `street`.
  assert.equal(data.address, "100 Main St, Austin, TX 78701, USA");
  assert.equal(data.street, "100 Main St");
  assert.equal(data.lat, POINT.lat);
  assert.equal(data.apiId, "1450707");
});

test("the Homegroups id follows its own recipe, and its name loses the suffix", () => {
  const meeting = toHomegroupsMeeting(
    candidate({ name: "Sunrise Group - Online" }),
    POINT,
  );
  assert.ok(meeting.success);
  assert.equal(meeting.data.name, "Sunrise Group");
  assert.equal(
    meeting.data.id,
    homegroupsMeetingId({
      name: "Sunrise Group",
      day: "thursday",
      time: "19:00",
      formattedAddress: "100 Main St, Austin, TX 78701, USA",
    }),
  );
});

test("the Regroup meeting matches what mapDirectoryToRats produces", () => {
  const meeting = toRegroupMeeting(
    candidate({ onlineNotes: undefined as never }),
    POINT,
  );
  assert.ok(meeting.success);
  const { data } = meeting;
  assert.equal(data.day, "thursday");
  assert.equal(data.street, "100 Main St");
  assert.equal(data.type, "AA");
  assert.equal(data.onlineNotes, "");
  assert.deepEqual(data.types, ["Big Book", "Closed", "English"]);
  assert.equal(data.dataAsOf, "2026-11-08");
});

test("Celebrate Recovery uses the apps' own spelling of the type", () => {
  const fit = toShapes(candidate({ fellowship: "CELEBRATE_RECOVERY" }), POINT);
  assert.equal(fit?.homegroups.type, "Celebrate Recovery");
  assert.equal(fit?.regroup.type, "Celebrate Recovery");
});

test("an online meeting with no street still fits Regroup's required street", () => {
  const { street: _street, ...online } = candidate({
    online: true,
    link: "https://zoom.us/j/1",
    formattedAddress: "",
  });
  const fit = toShapes(online as Candidate, POINT);
  assert.equal(fit?.regroup.street, "");
  assert.equal(fit?.homegroups.street, undefined);
  assert.equal(fit?.homegroups.link, "https://zoom.us/j/1");
});

test("a fellowship with no type in the apps doesn't fit", () => {
  assert.equal(
    toShapes(candidate({ fellowship: "SMART_RECOVERY" }), POINT),
    null,
  );
});

test("malformed values don't fit, whatever produced them", () => {
  for (const bad of [
    { time: "7:00 PM" },
    { time: "25:00" },
    { day: 7 },
    { dataAsOf: "last year" },
    { link: "javascript:alert(1)" },
    { name: "" },
  ]) {
    assert.equal(toShapes(candidate(bad as Partial<Candidate>), POINT), null);
  }
  assert.equal(toShapes(candidate(), { lat: 91, lng: 0 }), null);
});

test("no shape carries a field a group or a person owns", () => {
  const fit = toShapes(candidate(), POINT);
  const text = JSON.stringify(fit);
  for (const field of [
    "groupId",
    "houseId",
    "venmo",
    "paypal",
    "square",
    "addedByUid",
  ]) {
    assert.doesNotMatch(text, new RegExp(`"${field}"`));
  }
});
