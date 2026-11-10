import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { FELLOWSHIP_IDS } from "../domain/fellowships.js";

export const SOURCE_KINDS = [
  "meeting-guide-feed",
  "bmlt-aggregator",
  "html-pages",
] as const;

const SourceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
  fellowship: z.enum(FELLOWSHIP_IDS),
  name: z.string().min(2).max(120),
  url: z.url({ protocol: /^https?$/ }),
  kind: z.enum(SOURCE_KINDS),
  region: z.string().max(80).optional(),
  /**
   * An agent's find starts as proposed: a page could talk a scout into
   * registering a hostile site, so nothing from it publishes until a person approves.
   */
  status: z.enum(["approved", "proposed", "rejected"]),
  addedBy: z.enum(["seed", "agent", "operator"]),
  notes: z.string().max(500).optional(),
});

export type Source = z.infer<typeof SourceSchema>;

export const DEFAULT_REGISTRY = new URL(
  "../../data/sources.json",
  import.meta.url,
);

export class SourceRegistry {
  private sources = new Map<string, Source>();

  constructor(private readonly file: URL = DEFAULT_REGISTRY) {
    this.reload();
  }

  /** The operator may approve a source during a run, so every change starts from the file. */
  private reload(): void {
    const parsed = z
      .array(SourceSchema)
      .parse(JSON.parse(readFileSync(this.file, "utf8")));
    this.sources = new Map(parsed.map((source) => [source.id, source]));
  }

  list(): Source[] {
    return [...this.sources.values()];
  }

  asMap(): ReadonlyMap<string, Source> {
    return this.sources;
  }

  get(id: string): Source | undefined {
    return this.sources.get(id);
  }

  /** Agents only ever add proposals, and cannot change a source that exists. */
  propose(input: Omit<Source, "status" | "addedBy">): Source {
    this.reload();
    if (this.sources.has(input.id)) {
      throw new Error(`Source "${input.id}" already exists`);
    }
    const source = SourceSchema.parse({
      ...input,
      status: "proposed",
      addedBy: "agent",
    });
    this.sources.set(source.id, source);
    this.save();
    return source;
  }

  /** Naming the URL stops a plausible id on a hostile site being approved by its id alone. */
  approve(id: string, url: string): Source {
    this.reload();
    const current = this.sources.get(id);
    if (current && current.url !== url) {
      throw new Error(
        `"${id}" points at ${current.url}, not ${url}. Check it, then approve with that URL.`,
      );
    }
    return this.setStatus(id, "approved");
  }

  setStatus(id: string, status: "approved" | "rejected"): Source {
    this.reload();
    const current = this.sources.get(id);
    if (!current) throw new Error(`No source "${id}"`);
    const next = { ...current, status };
    this.sources.set(id, next);
    this.save();
    return next;
  }

  private save(): void {
    const sorted = this.list().sort((a, b) => a.id.localeCompare(b.id));
    const temporary = new URL(`${this.file.href}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(sorted, null, 2)}\n`);
    renameSync(temporary, this.file);
  }
}
