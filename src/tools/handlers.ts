import {
  type Candidate,
  candidateDigest,
  pageCandidate,
  PageMeetingInput,
} from "../domain/candidate.js";
import type { Fellowship } from "../domain/fellowships.js";
import {
  type BmltRegion,
  mapBmltRow,
  meetingsUrl,
  parseRegions,
  parseRows,
  regionsUrl,
} from "../feeds/bmlt.js";
import { mapFeedMeeting, parseFeed } from "../feeds/meetingGuideFeed.js";
import { type CrawlInput, type CrawlResult, crawlSite } from "../net/crawl.js";
import { redactContactInfo } from "../domain/safety.js";
import { type Fetcher, FetchRefused } from "../net/fetcher.js";
import { htmlToText } from "../net/html.js";
import type { RunStore } from "../store/runStore.js";
import type { Source, SourceRegistry } from "../store/sourceRegistry.js";

/** A page sent to a model in one call; longer ones are read by offset. */
const PAGE_CHARS = 20_000;
/** A collection this short of what the source reports isn't a full answer. */
const MIN_EXPECTED_SHARE = 0.9;

export interface HandlerDeps {
  store: RunStore;
  registry: SourceRegistry;
  fetcher: Fetcher;
  today: () => string;
  maxFetches?: number;
  maxProposals?: number;
}

export interface PageResult {
  status: string;
  untrusted: true;
  url?: string;
  snapshotId?: string;
  text?: string;
  offset?: number;
  totalChars?: number;
}

export interface CollectResult {
  status: "ok" | "failed";
  collectionKey: string;
  records: number;
  dropped: number;
  problem?: string;
}

const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, "");

export function createHandlers(deps: HandlerDeps) {
  const { store, registry, fetcher, today } = deps;
  const maxFetches = deps.maxFetches ?? 300;
  const maxProposals = deps.maxProposals ?? 20;
  let fetches = 0;
  let proposals = 0;

  const requireSource = (id: string): Source => {
    const source = registry.get(id);
    if (!source) throw new Error(`No source "${id}"; list_sources shows them`);
    return source;
  };

  async function getJson(url: string): Promise<unknown> {
    const page = await fetcher(url);
    if (page.status !== 200) {
      throw new Error(`The source answered ${page.status}`);
    }
    try {
      return JSON.parse(page.body);
    } catch {
      throw new Error("The source did not return JSON");
    }
  }

  function record(
    source: Source,
    key: string,
    candidates: Candidate[],
    rows: number,
    problem?: string,
  ): CollectResult {
    const status = problem ? "failed" : "ok";
    // Rows from a failed collection still count as seen, but decide no deletes.
    store.addCandidates(candidates);
    const dropped = rows - candidates.length;
    store.addCollection({
      key,
      sourceId: source.id,
      status,
      records: candidates.length,
      dropped,
      ...(problem ? { problem } : {}),
    });
    return {
      status,
      collectionKey: key,
      records: candidates.length,
      dropped,
      ...(problem ? { problem } : {}),
    };
  }

  async function collectBmlt(
    source: Source,
    regionId: number | undefined,
  ): Promise<CollectResult> {
    if (regionId === undefined) {
      throw new Error(
        "Collecting BMLT needs a regionId from list_bmlt_regions",
      );
    }
    const regions = parseRegions(await getJson(regionsUrl()));
    const region = regions.find((r) => r.id === regionId);
    if (!region) throw new Error(`BMLT has no region ${regionId}`);
    const key = `${source.id}#${region.sourceId}`;
    try {
      const url = meetingsUrl(region.id);
      const rows = parseRows(await getJson(url));
      const context = {
        sourceId: source.id,
        sourceUrl: url,
        dataAsOf: today(),
      };
      const candidates = rows.flatMap((row) => {
        const candidate = mapBmltRow(row, region, context);
        return candidate ? [candidate] : [];
      });
      const short = rows.length < region.expectedMeetings * MIN_EXPECTED_SHARE;
      return record(
        source,
        key,
        candidates,
        rows.length,
        short
          ? `Returned ${rows.length} of the ${region.expectedMeetings} it reports`
          : undefined,
      );
    } catch (error) {
      return record(source, key, [], 0, (error as Error).message);
    }
  }

  async function collectGuideFeed(source: Source): Promise<CollectResult> {
    try {
      const rows = parseFeed(await getJson(source.url));
      const context = {
        sourceId: source.id,
        sourceUrl: source.url,
        fellowship: source.fellowship as Fellowship,
        dataAsOf: today(),
      };
      const candidates = rows.flatMap((row) => mapFeedMeeting(row, context));
      return record(source, source.id, candidates, rows.length);
    } catch (error) {
      return record(source, source.id, [], 0, (error as Error).message);
    }
  }

  return {
    listSources(input: { fellowship?: string | undefined }) {
      return registry
        .list()
        .filter((s) => !input.fellowship || s.fellowship === input.fellowship);
    },

    registerSource(input: {
      id: string;
      fellowship: Source["fellowship"];
      name: string;
      url: string;
      kind: Source["kind"];
      region?: string | undefined;
      notes?: string | undefined;
    }): Source {
      if (proposals >= maxProposals) {
        throw new Error(
          `This run has proposed ${maxProposals} sources, its limit. Report the rest as a gap.`,
        );
      }
      // Agents read these back in later runs, and the registry goes into git.
      // Redaction can lengthen text, so it's cut back to the registry's limits.
      const clean = (text: string | undefined, max: number) =>
        text ? redactContactInfo(text).slice(0, max) : undefined;
      const { region: rawRegion, notes: rawNotes, name, ...rest } = input;
      const region = clean(rawRegion, 80);
      const notes = clean(rawNotes, 500);
      const source = registry.propose({
        ...rest,
        name: clean(name, 120) ?? "",
        ...(region ? { region } : {}),
        ...(notes ? { notes } : {}),
      });
      proposals++;
      return source;
    },

    async listBmltRegions(): Promise<BmltRegion[]> {
      return parseRegions(await getJson(regionsUrl()));
    },

    async collectFeed(input: {
      sourceId: string;
      regionId?: number | undefined;
    }): Promise<CollectResult> {
      const source = requireSource(input.sourceId);
      if (source.kind === "bmlt-aggregator") {
        return collectBmlt(source, input.regionId);
      }
      if (source.kind === "meeting-guide-feed") {
        return collectGuideFeed(source);
      }
      throw new Error(`"${source.id}" has no feed; extract its pages instead`);
    },

    /** Shares the run's fetch budget with fetch_page, so a crawl can't run up a bill. */
    crawlSite(input: CrawlInput): Promise<CrawlResult> {
      return crawlSite(input, {
        fetcher,
        take: () => (fetches < maxFetches ? (fetches++, true) : false),
        snapshot: (url, text) => store.addSnapshot(url, today(), text).id,
      });
    },

    async fetchPage(input: {
      url: string;
      offset?: number | undefined;
    }): Promise<PageResult> {
      if (fetches >= maxFetches) {
        return { status: "fetch-budget-spent", untrusted: true };
      }
      fetches++;
      try {
        const page = await fetcher(input.url);
        if (page.status === 401 || page.status === 403) {
          return { status: "access-denied", untrusted: true, url: page.url };
        }
        if (page.status === 429) {
          return { status: "rate-limited", untrusted: true, url: page.url };
        }
        if (page.status !== 200) {
          return {
            status: `http-${page.status}`,
            untrusted: true,
            url: page.url,
          };
        }
        if (/pdf/i.test(page.contentType)) {
          return { status: "unsupported:pdf", untrusted: true, url: page.url };
        }
        const text = /html/i.test(page.contentType)
          ? htmlToText(page.body)
          : page.body;
        const snapshot = store.addSnapshot(page.url, today(), text);
        const offset = input.offset ?? 0;
        return {
          status: "ok",
          untrusted: true,
          url: page.url,
          snapshotId: snapshot.id,
          text: text.slice(offset, offset + PAGE_CHARS),
          offset,
          totalChars: text.length,
        };
      } catch (error) {
        if (error instanceof FetchRefused) {
          return { status: `refused:${error.reason}`, untrusted: true };
        }
        return {
          status: `failed:${(error as Error).message}`,
          untrusted: true,
        };
      }
    },

    readSnapshot(input: {
      snapshotId: string;
      offset?: number | undefined;
    }): PageResult {
      const snapshot = store.snapshot(input.snapshotId);
      if (!snapshot) throw new Error("No such snapshot in this run");
      const offset = input.offset ?? 0;
      return {
        status: "ok",
        untrusted: true,
        url: snapshot.url,
        snapshotId: snapshot.id,
        text: snapshot.text.slice(offset, offset + PAGE_CHARS),
        offset,
        totalChars: snapshot.text.length,
      };
    },

    async submitCandidates(input: {
      sourceId: string;
      snapshotId: string;
      meetings: unknown[];
    }): Promise<{
      accepted: number;
      rejected: { index: number; reason: string }[];
    }> {
      const source = requireSource(input.sourceId);
      const snapshot = store.snapshot(input.snapshotId);
      if (!snapshot) throw new Error("No such snapshot in this run");
      if (hostOf(snapshot.url) !== hostOf(source.url)) {
        throw new Error(
          "That page is on a different site from the source; register its site as a source",
        );
      }

      const accepted: Candidate[] = [];
      const rejected: { index: number; reason: string }[] = [];
      input.meetings.forEach((raw, index) => {
        const parsed = PageMeetingInput.safeParse(raw);
        if (!parsed.success) {
          rejected.push({ index, reason: "bad-shape" });
          return;
        }
        if (parsed.data.fellowship !== source.fellowship) {
          rejected.push({ index, reason: "wrong-fellowship" });
          return;
        }
        const result = pageCandidate(parsed.data, {
          sourceId: source.id,
          snapshot,
        });
        if (result.ok) accepted.push(result.candidate);
        else rejected.push({ index, reason: result.reason });
      });
      store.addCandidates(accepted);
      return { accepted: accepted.length, rejected };
    },

    listPending(input: { limit?: number | undefined }) {
      const verdicts = store.verdicts();
      const pending = store
        .candidates()
        .filter(
          (c) =>
            c.origin === "page" &&
            verdicts.get(c.key)?.digest !== candidateDigest(c),
        );
      return {
        total: pending.length,
        meetings: pending.slice(0, input.limit ?? 25),
      };
    },

    recordVerdict(input: {
      key: string;
      verdict: "confirmed" | "rejected";
      reason: string;
    }): { recorded: true } {
      const candidate = store
        .candidates()
        .find((c) => c.key === input.key && c.origin === "page");
      if (!candidate) {
        throw new Error("No page meeting with that key in this run");
      }
      store.addVerdict(input.key, {
        verdict: input.verdict,
        reason: input.reason,
        digest: candidateDigest(candidate),
      });
      return { recorded: true };
    },

    runStatus() {
      const candidates = store.candidates();
      const verdicts = [...store.verdicts().values()];
      const byFellowship: Record<string, number> = {};
      for (const c of candidates) {
        byFellowship[c.fellowship] = (byFellowship[c.fellowship] ?? 0) + 1;
      }
      return {
        candidates: candidates.length,
        byFellowship,
        fromFeeds: candidates.filter((c) => c.origin === "feed").length,
        fromPages: candidates.filter((c) => c.origin === "page").length,
        confirmed: verdicts.filter((v) => v.verdict === "confirmed").length,
        rejected: verdicts.filter((v) => v.verdict === "rejected").length,
        collections: store.collections(),
      };
    },
  };
}

export type Handlers = ReturnType<typeof createHandlers>;
