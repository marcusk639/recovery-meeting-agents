// Bounded runs keep these linear: an unbounded `[\w.+-]+@` rescans a long word
// from every position, and the input can be a model's.
const EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/;
const SPELLED_EMAIL =
  /[\w.+-]{1,64}\s*(\(at\)|\[at\]|\sat\s)\s*\w[\w.-]{0,62}\s*(\(dot\)|\[dot\]|\sdot\s)\s*\w{1,24}/i;
const PHONE =
  /(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b|\b\d{10,11}\b/;
const SECRET = /\b(pass\s?code|pass\s?word|pwd|pin)\b/i;

/**
 * Parsers disagree about these. WHATWG reads `https://zoom.us\@evil.com` as host
 * zoom.us, where an RFC 3986 client reads host evil.com, so a link must not hold them.
 */
const AMBIGUOUS_URL_CHARS = /[\\\s\u0000-\u001f\u007f-\u009f]/;

const DIAL_IN_CHARS = /^[\p{L}\d\s().,:;*#+-]{7,80}$/u;
const DIAL_IN_WORDS = new Set([
  "access",
  "and",
  "call",
  "code",
  "conference",
  "dial",
  "enter",
  "id",
  "in",
  "meeting",
  "number",
  "phone",
  "then",
]);

const CONFERENCE_HOSTS = [
  "zoom.us",
  "zoom.com",
  "zoomgov.com",
  "meet.google.com",
  "teams.microsoft.com",
  "teams.live.com",
  "webex.com",
  "gotomeeting.com",
  "meet.goto.com",
  "whereby.com",
  "skype.com",
  "meet.jit.si",
];

/** Folds fullwidth digits and Unicode hyphens, so they can't hide a number. */
const fold = (text: string) => text.normalize("NFKC").replace(/[‐-―−]/g, "-");

export function containsContactInfo(text: string): boolean {
  const folded = fold(text);
  return EMAIL.test(folded) || PHONE.test(folded) || SPELLED_EMAIL.test(folded);
}

/**
 * Apps open this link, so anything but a plain http(s) URL is dropped. The raw
 * string is returned because document ids hash it: with the ambiguous characters
 * gone, every parser reads it the same way.
 */
export function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (AMBIGUOUS_URL_CHARS.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/**
 * Web pages and feeds are untrusted, and a person in early recovery will tap what
 * we publish, so a link must point at a real conferencing service.
 */
export function conferenceHostAllowed(link: string): boolean {
  if (!safeHttpUrl(link)) return false;
  const host = new URL(link).hostname.toLowerCase();
  return CONFERENCE_HOSTS.some(
    (known) => host === known || host.endsWith(`.${known}`),
  );
}

/** Removes emails and phone numbers from text that is kept, such as a source's notes. */
export function redactContactInfo(text: string): string {
  // Folding rewrites dashes and ligatures, so text with nothing to remove is kept as it was.
  if (!containsContactInfo(text)) return text;
  const global = (pattern: RegExp) =>
    new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
  return [EMAIL, SPELLED_EMAIL, PHONE].reduce(
    (out, pattern) => out.replace(global(pattern), "[contact removed]"),
    fold(text),
  );
}

/** Listings are public: passcodes and personal contact details stay out. */
export function scrubNotes(notes: unknown): string | undefined {
  if (typeof notes !== "string") return undefined;
  const text = notes.trim();
  if (!text || SECRET.test(text) || containsContactInfo(text)) return undefined;
  return text.slice(0, 500);
}

/**
 * A conference line, with only the words such lines use around its number, like
 * "Dial In 646-555-0100 Meeting 123456". Any other word could be a link or a
 * message, and a passcode stays out as it does in notes.
 */
export function safeDialIn(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const phone = value.trim().replace(/^tel:/i, "");
  const words = phone.match(/\p{L}+/gu) ?? [];
  const digits = phone.replace(/\D/g, "").length;
  if (!DIAL_IN_CHARS.test(phone) || digits < 7) return undefined;
  return words.every((word) => DIAL_IN_WORDS.has(word.toLowerCase()))
    ? phone
    : undefined;
}

/** Real coordinates, excluding the (0,0) that sources use for "no location". */
export function validPoint(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}
