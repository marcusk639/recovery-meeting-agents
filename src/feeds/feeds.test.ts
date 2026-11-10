import assert from "node:assert/strict";
import { test } from "node:test";
import { bmltMeetingId, directoryMeetingId } from "../domain/identity.js";
import { mapBmltRow } from "./bmlt.js";
import { mapFeedMeeting, parseFeed } from "./meetingGuideFeed.js";

const SOURCE = {
  sourceId: "tx-aa",
  sourceUrl: "https://intergroup.example/feed.json",
  fellowship: "AA" as const,
  dataAsOf: "2026-11-08",
};

const ROW = {
  name: "Sunrise Group - Online",
  slug: "sunrise",
  day: 1,
  time: "07:00",
  types: ["O", "D"],
  formatted_address: "100 Main St, Austin, TX 78701, USA",
  latitude: "30.2672",
  longitude: "-97.7431",
};

test("a feed row maps the way recovery-api maps it, so the id is the same", () => {
  const [c] = mapFeedMeeting(ROW, SOURCE);
  assert.ok(c);
  assert.equal(
    c.key,
    directoryMeetingId({
      name: "Sunrise Group - Online",
      day: 1,
      time: "07:00",
      link: "",
      formattedAddress: "100 Main St, Austin, TX 78701, USA",
    }),
  );
  assert.equal(c.name, "Sunrise Group - Online");
  assert.equal(c.lat, 30.2672);
  assert.equal(c.dataAsOf, "2026-11-08");
});

test("type codes become the words stored rows hold", () => {
  const [c] = mapFeedMeeting({ ...ROW, types: ["O", "BE", "NEW"] }, SOURCE);
  assert.equal(c?.type, "Open,Newcomer,NEW");
  assert.equal(c?.format, "Open,Newcomer,NEW");
  const [words] = mapFeedMeeting(
    { ...ROW, types: "Big Book,Closed,English" },
    SOURCE,
  );
  assert.equal(words?.format, "Big Book,Closed,English");
});

test("the id uses the street alone when the feed has no formatted address", () => {
  const { formatted_address: _full, ...parts } = ROW;
  const [c] = mapFeedMeeting(
    { ...parts, address: "100 Main St", city: "Austin", state: "TX" },
    SOURCE,
  );
  assert.equal(
    c?.key,
    directoryMeetingId({
      name: "Sunrise Group - Online",
      day: 1,
      time: "07:00",
      link: "",
      formattedAddress: "100 Main St",
    }),
  );
  assert.equal(c?.formattedAddress, "100 Main St, Austin, TX");
  assert.equal(c?.city, "Austin");
});

test("building and country carry through, for the apps' own shapes", () => {
  const [c] = mapFeedMeeting(
    { ...ROW, location: "First Church", country: "US" },
    SOURCE,
  );
  assert.equal(c?.locationName, "First Church");
  assert.equal(c?.country, "US");
});

test("a feed's (0,0) or out-of-range point isn't kept", () => {
  for (const [latitude, longitude] of [
    ["0", "0"],
    ["95", "10"],
  ]) {
    const [c] = mapFeedMeeting({ ...ROW, latitude, longitude }, SOURCE);
    assert.equal(c?.lat, undefined);
    assert.equal(c?.lng, undefined);
  }
});

test("a BMLT dial-in holds only a number", () => {
  const row = {
    source_id: "9",
    meeting_name: "Phone Group",
    weekday_tinyint: "2",
    start_time: "19:00:00",
    venue_type: "2",
    latitude: "30.2",
    longitude: "-97.7",
    published: "1",
  };
  const region = {
    id: 1,
    sourceId: 100,
    name: "Texas",
    expectedMeetings: 1,
    lastSuccessfulImport: null,
  };
  const context = {
    sourceId: "na",
    sourceUrl: SOURCE.sourceUrl,
    dataAsOf: "2026-11-08",
  };
  assert.equal(
    mapBmltRow(
      { ...row, phone_meeting_number: "+1 512 555 0142,,99#" },
      region,
      context,
    )?.onlineNotes,
    "Dial-in: +1 512 555 0142,,99#",
  );
  assert.equal(
    mapBmltRow(
      { ...row, phone_meeting_number: "visit evil.example" },
      region,
      context,
    ),
    null,
  );
});

test("contact and free-text fields never reach a candidate", () => {
  const [c] = mapFeedMeeting(
    {
      ...ROW,
      contact_1_name: "Dave R",
      contact_1_phone: "512-555-0142",
      entity_email: "info@intergroup.example",
      notes: "Ask for Dave",
    },
    SOURCE,
  );
  assert.ok(c);
  assert.doesNotMatch(JSON.stringify(c), /Dave|555-0142|info@/);
});

test("a row listed on several days becomes one candidate per day", () => {
  const rows = mapFeedMeeting({ ...ROW, day: [1, 3] }, SOURCE);
  assert.deepEqual(
    rows.map((r) => r.day),
    [1, 3],
  );
  assert.notEqual(rows[0]?.key, rows[1]?.key);
});

test("by-appointment rows and rows with a bad time are skipped", () => {
  const { day: _day, time: _time, ...appointment } = ROW;
  assert.deepEqual(mapFeedMeeting(appointment, SOURCE), []);
  assert.deepEqual(mapFeedMeeting({ ...ROW, time: "soon" }, SOURCE), []);
});

test("a temporarily closed location needs a way to join online", () => {
  const closed = { ...ROW, types: ["O", "TC"] };
  assert.deepEqual(mapFeedMeeting(closed, SOURCE), []);
  const [online] = mapFeedMeeting(
    { ...closed, conference_url: "https://zoom.us/j/1" },
    SOURCE,
  );
  assert.equal(online?.online, true);
});

test("an approximate location with no way to join is skipped", () => {
  assert.deepEqual(mapFeedMeeting({ ...ROW, approximate: "yes" }, SOURCE), []);
});

test("an unsafe conference link is dropped, and passcode notes stay out", () => {
  const [c] = mapFeedMeeting(
    {
      ...ROW,
      conference_url: "javascript:alert(1)",
      conference_phone: "+15125550142",
      conference_url_notes: "Passcode 1234",
    },
    SOURCE,
  );
  assert.ok(c);
  assert.equal(c.link, undefined);
  assert.equal(c.onlineNotes, undefined);
  assert.equal(c.online, true);
});

test("a body that isn't an array is a failure, not an empty feed", () => {
  assert.throws(() => parseFeed({ error: "HTTP/1.1 401 Unauthorized" }));
  assert.deepEqual(parseFeed([]), []);
});

const REGION = {
  id: 1,
  sourceId: 100,
  name: "Texas",
  expectedMeetings: 2,
  lastSuccessfulImport: "2026-11-07T04:00:00Z",
};

const BMLT = {
  source_id: "55",
  meeting_name: "Just for Today",
  weekday_tinyint: "1",
  start_time: "19:00:00",
  venue_type: "1",
  formats: "O,D",
  latitude: "30.2",
  longitude: "-97.7",
  location_street: "1 Elm St",
  location_municipality: "Austin",
  location_province: "TX",
  location_postal_code_1: "78701",
  published: "1",
};

test("BMLT Sunday is 1 upstream and 0 in the directory", () => {
  const c = mapBmltRow(BMLT, REGION, SOURCE);
  assert.equal(c?.day, 0);
  assert.equal(c?.sourceRegion, "100");
  assert.equal(c?.externalId, "100:55");
  assert.equal(c?.collectionKey, "tx-aa#100");
  assert.equal(c?.fellowship, "NA");
  assert.equal(c?.dataAsOf, "2026-11-07");
});

test("a BMLT row keeps the id recovery-api's sync gives it, through edits", () => {
  const c = mapBmltRow(BMLT, REGION, SOURCE);
  assert.equal(c?.key, bmltMeetingId(100, "55"));
  const renamed = mapBmltRow(
    { ...BMLT, meeting_name: "New Name", start_time: "20:00:00" },
    REGION,
    SOURCE,
  );
  assert.equal(renamed?.key, c?.key);
  const { source_id: _id, ...noId } = BMLT;
  assert.equal(mapBmltRow(noId, REGION, SOURCE), null);
});

test("BMLT service committees and unpublished rows are not recovery meetings", () => {
  assert.equal(mapBmltRow({ ...BMLT, formats: "ASM" }, REGION, SOURCE), null);
  assert.equal(
    mapBmltRow({ ...BMLT, meeting_name: "Area Service" }, REGION, SOURCE),
    null,
  );
  assert.equal(mapBmltRow({ ...BMLT, published: "0" }, REGION, SOURCE), null);
});

test("a BMLT virtual meeting with no way to join is skipped", () => {
  assert.equal(mapBmltRow({ ...BMLT, venue_type: "2" }, REGION, SOURCE), null);
});
