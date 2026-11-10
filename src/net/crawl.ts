import * as cheerio from "cheerio";
import { type Fetcher, FetchRefused } from "./fetcher.js";
import { htmlToText } from "./html.js";

/**
 * A small crawl of one site, for finding where it lists meetings. Every request
 * goes through the guarded fetcher (public addresses, robots.txt, throttling).
 * It returns URLs and counts, not page text, so a hostile page has little room
 * to talk to the agent; titles and link text are short and marked untrusted.
 */

export const DEFAULT_DEPTH = 2;
export const MAX_DEPTH = 3;
export const DEFAULT_PAGES = 25;
export const MAX_PAGES = 60;
/** A page listing at least this many start times is probably a meeting list. */
export const MEETING_PAGE_MIN_TIMES = 5;

const MAX_FEEDS = 3;
const MAX_MEETING_PAGES = 10;
const MAX_EXTERNAL_SITES = 30;
const MAX_TEXT = 80;
const MAX_DOCUMENTS = 20;
/** Links are page-chosen strings the agent reads, so long ones and floods are dropped. */
const MAX_URL = 300;
const MAX_LINKS_PER_PAGE = 500;

const DOCUMENT = /\.(pdf|docx?|xlsx?|pptx?)$/i;
const NOT_A_PAGE =
  /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|svg|webp|ico|zip|mp[34]|mov|ics|css|js|xml|rss|txt)$/i;
const MEETING_HINT =
  /meeting|find|schedule|directory|intergroup|central[- ]office|local|groups|where|calendar|online/i;
const NOT_SERVICE_BODY =
  /(^|\.)(facebook|twitter|x|instagram|youtube|youtu|linkedin|tiktok|google|apple|pinterest|meetup|eventbrite|paypal|venmo|amazon|wordpress|squarespace|wix|godaddy|zoom|office|live|microsoft|square)\.(com|be|org|us|site)$|(^|\.)(goo\.gl|bit\.ly|tinyurl\.com|t\.co)$/i;
const TIME = /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])/gi;
const DAY =
  /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/gi;

export interface CrawlInput {
  url: string;
  maxDepth?: number | undefined;
  maxPages?: number | undefined;
}

export interface CrawlDeps {
  fetcher: Fetcher;
  /** Takes one fetch from the run's budget; false when it's spent. */
  take: () => boolean;
  /** Stores a page's text for this run and returns its snapshot id. */
  snapshot: (url: string, text: string) => string;
}

export interface CrawlResult {
  untrusted: true;
  site: string;
  pagesFetched: number;
  stoppedBecause: "done" | "page-limit" | "fetch-budget" | "rate-limited";
  meetingPages: {
    url: string;
    title: string;
    times: number;
    days: number;
    snapshotId: string;
  }[];
  feeds: { url: string; status: string; meetings?: number }[];
  /** Other sites this one links to, such as a directory's local offices. */
  externalSites: { host: string; url: string; text: string; links: number }[];
  /** Documents, such as PDF meeting lists, that can't be read yet. */
  documents: string[];
  refused: { url: string; reason: string }[];
  failed: { url: string; status: string }[];
}

const siteOf = (url: string) =>
  new URL(url).hostname.toLowerCase().replace(/^www\./, "");

/** One page, whether it's linked with or without www. */
const pageKey = (url: string) => {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/(.)\/$/, "$1");
  return `${siteOf(url)}${path}${parsed.search}`;
};

const short = (text: string) =>
  text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);

export function extractLinks(
  html: string,
  base: string,
): { url: string; text: string }[] {
  const $ = cheerio.load(html);
  const links = new Map<string, string>();
  $("a[href]").each((_, element) => {
    if (links.size >= MAX_LINKS_PER_PAGE) return false;
    try {
      const url = new URL($(element).attr("href") ?? "", base);
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      url.hash = "";
      if (url.href.length > MAX_URL) return;
      if (!links.has(url.href)) links.set(url.href, short($(element).text()));
    } catch {
      // An unparseable href is skipped.
    }
  });
  return [...links].map(([url, text]) => ({ url, text }));
}

/** Where a page built on Code for Recovery's tools publishes its Meeting Guide feed. */
export function feedCandidates(html: string, base: string): string[] {
  const $ = cheerio.load(html);
  const found: string[] = [];
  const dataSrc = $("#tsml-ui").attr("data-src");
  if (dataSrc) {
    try {
      const url = new URL(dataSrc, base);
      const web = url.protocol === "http:" || url.protocol === "https:";
      if (web && url.href.length <= MAX_URL) found.push(url.href);
    } catch {
      // Not a URL.
    }
  }
  if (/12-step-meeting-list|tsml_/i.test(html)) {
    found.push(new URL("/wp-admin/admin-ajax.php?action=meetings", base).href);
  }
  return found;
}

async function checkFeed(
  url: string,
  site: string,
  deps: CrawlDeps,
): Promise<CrawlResult["feeds"][number]> {
  // A feed that wasn't checked is still reported, so it isn't read as "no feed".
  if (!deps.take()) return { url, status: "unchecked:fetch-budget" };
  try {
    const page = await deps.fetcher(url);
    if (page.status === 401 || page.status === 403) {
      return { url, status: "locked" };
    }
    if (page.status === 429) return { url, status: "rate-limited" };
    if (page.status !== 200) return { url, status: `http-${page.status}` };
    if (siteOf(page.url) !== site)
      return { url, status: "redirected-off-site" };
    const body: unknown = JSON.parse(page.body);
    return Array.isArray(body)
      ? { url, status: "ok", meetings: body.length }
      : { url, status: "not-a-feed" };
  } catch (error) {
    if (error instanceof FetchRefused) {
      return { url, status: `refused:${error.reason}` };
    }
    return {
      url,
      status: error instanceof SyntaxError ? "not-a-feed" : "error",
    };
  }
}

export async function crawlSite(
  input: CrawlInput,
  deps: CrawlDeps,
): Promise<CrawlResult> {
  const seed = new URL(input.url);
  if (seed.protocol !== "http:" && seed.protocol !== "https:") {
    throw new Error("A crawl starts from an http or https URL");
  }
  seed.hash = "";
  const maxDepth = Math.min(input.maxDepth ?? DEFAULT_DEPTH, MAX_DEPTH);
  const maxPages = Math.min(input.maxPages ?? DEFAULT_PAGES, MAX_PAGES);
  const site = siteOf(seed.href);

  const result: CrawlResult = {
    untrusted: true,
    site,
    pagesFetched: 0,
    stoppedBecause: "done",
    meetingPages: [],
    feeds: [],
    externalSites: [],
    documents: [],
    refused: [],
    failed: [],
  };
  const seen = new Set([pageKey(seed.href)]);
  const feeds = new Set<string>();
  const external = new Map<string, CrawlResult["externalSites"][number]>();
  let frontier = [seed.href];

  crawl: for (
    let depth = 0;
    depth <= maxDepth && frontier.length > 0;
    depth++
  ) {
    const next: { url: string; hinted: boolean }[] = [];
    for (const url of frontier) {
      if (result.pagesFetched >= maxPages) {
        result.stoppedBecause = "page-limit";
        break crawl;
      }
      if (!deps.take()) {
        result.stoppedBecause = "fetch-budget";
        break crawl;
      }
      let page;
      try {
        page = await deps.fetcher(url);
      } catch (error) {
        if (error instanceof FetchRefused) {
          result.refused.push({ url, reason: error.reason });
        } else {
          result.failed.push({ url, status: "error" });
        }
        continue;
      } finally {
        result.pagesFetched++;
      }
      // A site that is rate-limiting has asked us to stop, so the crawl does.
      if (page.status === 429) {
        result.refused.push({ url, reason: "rate-limited" });
        result.stoppedBecause = "rate-limited";
        break crawl;
      }
      if (page.status === 401 || page.status === 403) {
        result.refused.push({ url, reason: "access-denied" });
        continue;
      }
      if (page.status !== 200) {
        result.failed.push({ url, status: `http-${page.status}` });
        continue;
      }
      seen.add(pageKey(page.url));
      if (!/html/i.test(page.contentType)) continue;
      // A redirect can land elsewhere. That site is reported, not crawled.
      if (siteOf(page.url) !== site) {
        const host = siteOf(page.url);
        if (!external.has(host)) {
          external.set(host, { host, url: page.url, text: "", links: 1 });
        }
        continue;
      }

      const text = htmlToText(page.body);
      const times = text.match(TIME)?.length ?? 0;
      if (times >= MEETING_PAGE_MIN_TIMES) {
        result.meetingPages.push({
          url: page.url,
          title: short(cheerio.load(page.body)("title").text()),
          times,
          days: text.match(DAY)?.length ?? 0,
          snapshotId: deps.snapshot(page.url, text),
        });
      }
      for (const feed of feedCandidates(page.body, page.url)) {
        // A page can point its feed anywhere; another site's is listed, not fetched.
        const host = siteOf(feed);
        if (host === site) feeds.add(feed);
        else if (!external.has(host)) {
          external.set(host, { host, url: feed, text: "feed", links: 1 });
        }
      }

      for (const link of extractLinks(page.body, page.url)) {
        const host = siteOf(link.url);
        if (host !== site) {
          if (NOT_SERVICE_BODY.test(host)) continue;
          const entry = external.get(host);
          if (entry) entry.links++;
          else
            external.set(host, {
              host,
              url: link.url,
              text: link.text,
              links: 1,
            });
          continue;
        }
        if (seen.has(pageKey(link.url))) continue;
        seen.add(pageKey(link.url));
        const path = new URL(link.url).pathname;
        if (DOCUMENT.test(path) && result.documents.length < MAX_DOCUMENTS) {
          result.documents.push(link.url);
        }
        if (NOT_A_PAGE.test(path)) continue;
        next.push({
          url: link.url,
          hinted: MEETING_HINT.test(`${link.text} ${path}`),
        });
      }
    }
    // Links that look like they lead to a meeting list go first.
    frontier = [
      ...next.filter((l) => l.hinted),
      ...next.filter((l) => !l.hinted),
    ].map((l) => l.url);
  }

  for (const url of [...feeds].slice(0, MAX_FEEDS)) {
    result.feeds.push(
      result.stoppedBecause === "rate-limited"
        ? { url, status: "unchecked:rate-limited" }
        : await checkFeed(url, site, deps),
    );
  }
  // A site that locks its feed has said no to apps reading its meetings. A cache
  // file its own finder loads isn't a way around that.
  if (result.feeds.some((feed) => feed.status === "locked")) {
    result.feeds = result.feeds.map(({ url }) => ({ url, status: "locked" }));
  }
  result.meetingPages = result.meetingPages
    .sort((a, b) => b.times - a.times)
    .slice(0, MAX_MEETING_PAGES);
  result.externalSites = [...external.values()]
    .sort((a, b) => b.links - a.links)
    .slice(0, MAX_EXTERNAL_SITES);
  return result;
}
