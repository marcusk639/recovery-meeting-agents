import { lookup as dnsLookupCallback } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import robotsParserModule from "robots-parser";
import { Agent, fetch as undiciFetch } from "undici";

// Its typings describe a namespace; at runtime the CommonJS export is the function.
type RobotsFactory = (
  url: string,
  contents: string,
) => { isDisallowed(url: string, userAgent?: string): boolean | undefined };
const robotsParser = robotsParserModule as unknown as RobotsFactory;

export type RefusalReason =
  "bad-url" | "private-address" | "robots" | "too-many-redirects" | "too-large";

/** A request we chose not to make, as opposed to one the site answered. */
export class FetchRefused extends Error {
  constructor(
    readonly reason: RefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "FetchRefused";
  }
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

export type Fetcher = (url: string) => Promise<FetchedPage>;

type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

export interface FetcherOptions {
  fetchFn?: typeof fetch;
  lookup?: Lookup;
  /** Gap between requests to one host, so a run stays a polite visitor. */
  minIntervalMs?: number;
  maxBytes?: number;
  timeoutMs?: number;
  userAgent?: string;
}

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const plain = mapped?.[1] ?? address;
  const family = isIP(plain);
  if (family === 0) return false;
  return !blocked.check(plain, family === 4 ? "ipv4" : "ipv6");
}

const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true });

type LookupCallback = (
  error: Error | null,
  address?: string | { address: string; family: number }[],
  family?: number,
) => void;

/** A `net.connect` lookup that refuses to hand a non-public address to the socket. */
export function guardedLookup(
  base: typeof dnsLookupCallback = dnsLookupCallback,
) {
  return (host: string, options: object, callback: LookupCallback): void => {
    (base as unknown as (h: string, o: object, c: LookupCallback) => void)(
      host,
      options,
      (error, address, family) => {
        if (error) return callback(error);
        const addresses = Array.isArray(address)
          ? address.map((entry) => entry.address)
          : [address ?? ""];
        if (!addresses.every(isPublicAddress)) {
          return callback(
            new Error(`${host} did not resolve to a public address`),
          );
        }
        callback(null, address, family);
      },
    );
  };
}

const guardedAgent = new Agent({
  connect: { lookup: guardedLookup() as never },
});

const guardedFetch = ((url: string, init: object) =>
  undiciFetch(url, {
    ...init,
    dispatcher: guardedAgent,
  })) as unknown as typeof fetch;

async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new FetchRefused("too-large", `Body is over ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Agents choose the URLs, and pages can steer them, so every hop is checked
 * here: web schemes on default ports, public addresses, and robots.txt. The
 * default fetch also checks the address it actually connects to, because a page's
 * owner controls their DNS and can answer differently the second time.
 */
export function createFetcher(options: FetcherOptions = {}): Fetcher {
  const fetchFn = options.fetchFn ?? guardedFetch;
  const lookup = options.lookup ?? defaultLookup;
  const minIntervalMs = options.minIntervalMs ?? 1000;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const userAgent =
    options.userAgent ??
    `RecoveryMeetingAgents/0.1${process.env.CRAWLER_CONTACT_URL ? ` (+${process.env.CRAWLER_CONTACT_URL})` : ""}`;

  const robots = new Map<string, ReturnType<typeof robotsParser> | "deny">();
  const nextSlot = new Map<string, number>();

  async function checkAddress(url: URL): Promise<void> {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new FetchRefused("bad-url", `Refused scheme ${url.protocol}`);
    }
    if (url.port || url.username || url.password) {
      throw new FetchRefused("bad-url", "Refused port or credentials in URL");
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host)
      ? [{ address: host }]
      : await lookup(host).catch(() => {
          throw new FetchRefused("bad-url", `Could not resolve ${host}`);
        });
    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => !isPublicAddress(address))
    ) {
      throw new FetchRefused("private-address", `${host} is not public`);
    }
  }

  async function throttled(url: URL): Promise<Response> {
    const now = Date.now();
    const slot = Math.max(now, nextSlot.get(url.host) ?? 0);
    nextSlot.set(url.host, slot + minIntervalMs);
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
    return fetchFn(url.href, {
      redirect: "manual",
      headers: { "user-agent": userAgent },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function checkRobots(url: URL): Promise<void> {
    let rules = robots.get(url.origin);
    if (!rules) {
      const robotsUrl = new URL("/robots.txt", url.origin);
      let response: Response | undefined;
      try {
        let target = robotsUrl;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          response = await throttled(target);
          const location = response.headers.get("location");
          if (response.status < 300 || response.status >= 400 || !location) {
            break;
          }
          await response.body?.cancel();
          response = undefined;
          target = new URL(location, target);
          await checkAddress(target);
        }
      } catch {
        response = undefined;
      }
      // Missing means no rules. A refusal or an outage means we can't know, so
      // the cautious reading applies, as the Robots Exclusion Protocol describes.
      if (response && response.status >= 200 && response.status < 300) {
        // Keyed by the origin being checked, even if the file was served from a redirect.
        rules = robotsParser(
          robotsUrl.href,
          await readLimited(response, 512 * 1024),
        );
      } else if (
        response &&
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 401 &&
        response.status !== 403 &&
        response.status !== 429
      ) {
        rules = robotsParser(robotsUrl.href, "");
      } else {
        rules = "deny";
      }
      robots.set(url.origin, rules);
    }
    if (rules === "deny" || rules.isDisallowed(url.href, userAgent) === true) {
      throw new FetchRefused("robots", `robots.txt refuses ${url.pathname}`);
    }
  }

  return async function get(raw: string): Promise<FetchedPage> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new FetchRefused("bad-url", "Not a URL");
    }

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await checkAddress(url);
      await checkRobots(url);
      const response = await throttled(url);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        url = new URL(location, url);
        continue;
      }
      return {
        url: url.href,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        body: await readLimited(response, maxBytes),
      };
    }
    throw new FetchRefused("too-many-redirects", "Too many redirects");
  };
}
