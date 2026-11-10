import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidateDigest,
  type Candidate,
  pageCandidate,
  PageMeetingInput,
} from "./candidate.js";

const SNAPSHOT = {
  id: "snap1",
  url: "https://example-intergroup.org/meetings",
  fetchedAt: "2026-11-08",
  text: `Monday
  Sunrise Group 7:00 AM, First Church, 100 Main St, Austin, TX 78701
  Tuesday
  Online: Serenity Now 6:30 PM (https://zoom.us/j/999)
  Thursday
  Night Owls 7 pm, 200 Oak Ave, Austin, TX 78701
  Friday
  Bare Time Group 7:00, 300 Elm St, Austin, TX 78701`,
};

const VALID = {
  fellowship: "AA",
  name: "Sunrise Group",
  day: "Monday",
  time: "7:00 AM",
  street: "100 Main St",
  city: "Austin",
  state: "TX",
  zip: "78701",
  online: false,
  quote: "Sunrise Group 7:00 AM, First Church, 100 Main St, Austin, TX 78701",
};

const build = (over: Record<string, unknown> = {}) =>
  pageCandidate(PageMeetingInput.parse({ ...VALID, ...over }), {
    sourceId: "src",
    snapshot: SNAPSHOT,
  });

const refused = (reason: string) => ({ ok: false, reason });

test("a meeting traceable to the page becomes a candidate", () => {
  const result = build({ locationName: "First Church" });
  assert.ok(result.ok);
  assert.equal(result.candidate.day, 1);
  assert.equal(result.candidate.time, "07:00");
  assert.equal(result.candidate.origin, "page");
  assert.equal(result.candidate.key.length, 24);
  assert.equal(result.candidate.evidence?.snapshotId, "snap1");
  assert.equal(result.candidate.locationName, "First Church");
});

test("the quote must be on the page, however whitespace differs", () => {
  assert.ok(
    build({
      quote: "Sunrise   Group 7:00 AM,\nFirst Church, 100 Main St",
    }).ok,
  );
  assert.deepEqual(
    build({ quote: "Sunrise Group 7:00 AM at Invented Hall" }),
    refused("quote-not-on-page"),
  );
});

test("the name must be inside the quote", () => {
  assert.deepEqual(
    build({ name: "Another Group" }),
    refused("name-not-in-quote"),
  );
});

test("each address part must be on the page, or the geocoder goes elsewhere", () => {
  assert.deepEqual(
    build({ street: "200 Pine St" }),
    refused("street-not-on-page"),
  );
  assert.deepEqual(build({ city: "Dallas" }), refused("city-not-on-page"));
  assert.deepEqual(build({ state: "OK" }), refused("state-not-on-page"));
  assert.deepEqual(build({ zip: "75201" }), refused("zip-not-on-page"));
});

test("a page's fragment of a street isn't a street", () => {
  assert.deepEqual(build({ street: "Main St" }), refused("street-too-vague"));
  assert.deepEqual(
    build({ street: "00 Main St" }),
    refused("street-not-on-page"),
  );
});

test("a format and building must be on the page too", () => {
  assert.deepEqual(build({ format: "Speaker" }), refused("format-not-on-page"));
  assert.deepEqual(
    build({ locationName: "Second Church" }),
    refused("location-name-not-on-page"),
  );
});

test("the time must be in the quote, so it can't be swapped", () => {
  assert.deepEqual(build({ time: "9:00 AM" }), refused("time-not-in-quote"));
  assert.deepEqual(build({ time: "7:00 PM" }), refused("time-not-in-quote"));
  assert.deepEqual(build({ time: "19:00" }), refused("time-not-in-quote"));
});

test("a time written without minutes still traces", () => {
  const result = build({
    name: "Night Owls",
    day: "Thursday",
    time: "7:00 PM",
    street: "200 Oak Ave",
    quote: "Night Owls 7 pm, 200 Oak Ave, Austin, TX 78701",
  });
  assert.ok(result.ok);
  assert.equal(result.candidate.time, "19:00");
});

test("a bare 7:00 is refused, because it could be morning or evening", () => {
  assert.deepEqual(
    build({
      name: "Bare Time Group",
      day: "Friday",
      time: "7:00",
      street: "300 Elm St",
      quote: "Bare Time Group 7:00, 300 Elm St, Austin, TX 78701",
    }),
    refused("time-not-in-quote"),
  );
});

test("the day must be on the page, with heading days allowed", () => {
  assert.deepEqual(build({ day: "Sunday" }), refused("day-not-on-page"));
  assert.ok(build({ day: "Monday" }).ok);
  assert.ok(build({ day: 1 }).ok);
});

test("a link must appear on the page and be a conferencing host", () => {
  const online = {
    name: "Serenity Now",
    day: "Tuesday",
    time: "6:30 PM",
    online: true,
    street: undefined,
    city: undefined,
    state: undefined,
    zip: undefined,
    quote: "Serenity Now 6:30 PM (https://zoom.us/j/999)",
  };
  assert.ok(build({ ...online, link: "https://zoom.us/j/999" }).ok);
  assert.deepEqual(
    build({ link: "https://zoom.us/j/111" }),
    refused("link-not-on-page"),
  );
  const hostile = {
    ...SNAPSHOT,
    text: `${SNAPSHOT.text} https://evil.example/join`,
  };
  assert.deepEqual(
    pageCandidate(
      PageMeetingInput.parse({ ...VALID, link: "https://evil.example/join" }),
      { sourceId: "src", snapshot: hostile },
    ),
    refused("link-host-not-allowed"),
  );
});

test("contact details in any field are refused", () => {
  const snapshot = {
    ...SNAPSHOT,
    text: `${SNAPSHOT.text}
    Monday Call Dave 512-555-0142 Group 7:00 AM here
    100 Main St, Austin, TX ask dave@example.org`,
  };
  assert.deepEqual(
    pageCandidate(
      PageMeetingInput.parse({
        ...VALID,
        name: "Call Dave 512-555-0142 Group",
        quote: "Call Dave 512-555-0142 Group 7:00 AM",
      }),
      { sourceId: "src", snapshot },
    ),
    refused("contact-info"),
  );
  assert.deepEqual(
    pageCandidate(
      PageMeetingInput.parse({ ...VALID, format: "ask dave@example.org" }),
      { sourceId: "src", snapshot },
    ),
    refused("contact-info"),
  );
});

test("an unparseable day or time is refused rather than guessed", () => {
  assert.deepEqual(build({ day: "Someday" }), refused("bad-day-or-time"));
  assert.deepEqual(build({ time: "evening" }), refused("bad-day-or-time"));
});

test("an in-person meeting needs an address and an online one needs a way in", () => {
  assert.deepEqual(build({ street: undefined }), refused("no-address"));
  assert.deepEqual(
    build({
      online: true,
      street: undefined,
      city: undefined,
      state: undefined,
      zip: undefined,
    }),
    refused("no-way-to-join"),
  );
});

test("unknown fields are rejected, so contact fields cannot slip through", () => {
  assert.throws(() =>
    PageMeetingInput.parse({ ...VALID, contact_1_phone: "512-555-0142" }),
  );
});

test("the name is hashed as written, as recovery-api does", () => {
  const snapshot = {
    ...SNAPSHOT,
    text: "Monday Sunrise Group - Online 7:00 AM, 100 Main St, Austin, TX 78701",
  };
  const result = pageCandidate(
    PageMeetingInput.parse({
      ...VALID,
      name: "Sunrise Group - Online",
      quote: "Sunrise Group - Online 7:00 AM, 100 Main St",
    }),
    { sourceId: "src", snapshot },
  );
  assert.ok(result.ok);
  assert.equal(result.candidate.name, "Sunrise Group - Online");
});

test("a digest changes with any field, including ones outside the id", () => {
  const result = build();
  assert.ok(result.ok);
  const changed: Candidate = { ...result.candidate, format: "Speaker" };
  assert.notEqual(candidateDigest(result.candidate), candidateDigest(changed));
});
