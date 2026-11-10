import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conferenceHostAllowed,
  containsContactInfo,
  redactContactInfo,
  safeDialIn,
  safeHttpUrl,
  scrubNotes,
  validPoint,
} from "./safety.js";

test("contact details are detected so they never reach a listing", () => {
  assert.equal(containsContactInfo("call Dave at 512-555-0142"), true);
  assert.equal(containsContactInfo("(512) 555-0142"), true);
  assert.equal(containsContactInfo("dave.r@example.org"), true);
  assert.equal(containsContactInfo("Sunrise Group 7:00"), false);
  assert.equal(containsContactInfo("Room 1204, Building 12"), false);
});

test("only http(s) links survive, because apps open them", () => {
  assert.equal(safeHttpUrl("javascript:alert(1)"), undefined);
  assert.equal(safeHttpUrl("virtually"), undefined);
  assert.equal(safeHttpUrl("ftp://example.org/x"), undefined);
  assert.equal(safeHttpUrl(" https://zoom.us/j/123 "), "https://zoom.us/j/123");
});

test("a credentialed link is refused", () => {
  assert.equal(safeHttpUrl("https://user:pw@zoom.us/j/1"), undefined);
});

test("a link parsers disagree about is refused", () => {
  assert.equal(safeHttpUrl("https://zoom.us\\@evil.example/x"), undefined);
  assert.equal(
    conferenceHostAllowed("https://zoom.us\\@evil.example/x"),
    false,
  );
  assert.equal(safeHttpUrl("https://zo\nom.us/j/1"), undefined);
  assert.equal(safeHttpUrl("https://zoom.us/j/1 x"), undefined);
});

test("contact details can't hide behind formatting", () => {
  assert.equal(containsContactInfo("Call 5125550142"), true);
  assert.equal(containsContactInfo("512‐555‐0142"), true);
  assert.equal(containsContactInfo("５１２-555-0142"), true);
  assert.equal(containsContactInfo("dave at example dot org"), true);
  assert.equal(containsContactInfo("Meet at the church"), false);
  assert.equal(containsContactInfo("78701"), false);
});

test("a dial-in holds a number and nothing else", () => {
  assert.equal(
    safeDialIn("+1 (512) 555-0142,,123#"),
    "+1 (512) 555-0142,,123#",
  );
  assert.equal(safeDialIn("call https://evil.example"), undefined);
  assert.equal(
    safeDialIn("Dial In 646-555-0100 Meeting 123456"),
    "Dial In 646-555-0100 Meeting 123456",
  );
  assert.equal(safeDialIn("tel:+16465550100,,,123#"), "+16465550100,,,123#");
  assert.equal(safeDialIn("Call Dave 646-555-0100"), undefined);
  assert.equal(safeDialIn("646-555-0100 Passcode 1234"), undefined);
  assert.equal(safeDialIn("call in"), undefined);
});

test("(0,0) and out-of-range points aren't locations", () => {
  assert.equal(validPoint(30.2, -97.7), true);
  assert.equal(validPoint(0, 0), false);
  assert.equal(validPoint(91, 0), false);
  assert.equal(validPoint(undefined, 0), false);
});

test("page-extracted links must point at a known conferencing host", () => {
  assert.equal(conferenceHostAllowed("https://us02web.zoom.us/j/123"), true);
  assert.equal(conferenceHostAllowed("https://meet.google.com/abc"), true);
  assert.equal(
    conferenceHostAllowed("https://zoom.us.evil.example/j/1"),
    false,
  );
  assert.equal(conferenceHostAllowed("https://evil.example/zoom.us"), false);
  assert.equal(conferenceHostAllowed("not a url"), false);
});

test("notes holding a passcode or contact details are dropped", () => {
  assert.equal(scrubNotes("Passcode: 12345"), undefined);
  assert.equal(scrubNotes("password is serenity"), undefined);
  assert.equal(scrubNotes("ask for jim@example.org"), undefined);
  assert.equal(scrubNotes("Join by phone only"), "Join by phone only");
  assert.equal(scrubNotes("   "), undefined);
  assert.equal(scrubNotes(undefined), undefined);
});

test("redaction removes a spelled-out address from its first word", () => {
  assert.equal(
    redactContactInfo("Write jsmith at gmail dot com today"),
    "Write [contact removed] today",
  );
});

test("text with nothing to remove is returned unchanged", () => {
  const text = "Mon–Fri 7:00–8:00 PM, zip 92108-1234";
  assert.equal(redactContactInfo(text), text);
});

test("contact checks stay fast on long input", () => {
  const start = performance.now();
  containsContactInfo("a".repeat(100_000));
  redactContactInfo(`${"a".repeat(100_000)} at ${"b".repeat(50_000)}`);
  assert.ok(performance.now() - start < 500);
});
