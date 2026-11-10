import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Candidate, Snapshot } from "../domain/candidate.js";
import type { CollectionRecord, Verdict } from "../publish/plan.js";

export const DEFAULT_RUNS_DIR = fileURLToPath(
  new URL("../../runs/", import.meta.url),
);

const RUN_ID = /^[\w-]{1,80}$/;

export interface RunMeta {
  id: string;
  startedAt: string;
  fellowships: string[];
  region: string;
}

export type StoredCollection = CollectionRecord & {
  sourceId: string;
  problem?: string;
  dropped?: number;
};

export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

/** Everything one run found. Runs stay on disk so a publish can be reviewed first. */
export class RunStore {
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static create(meta: RunMeta, root = DEFAULT_RUNS_DIR): RunStore {
    if (!RUN_ID.test(meta.id)) throw new Error("Bad run id");
    const dir = join(root, meta.id);
    mkdirSync(join(dir, "snapshots"), { recursive: true });
    writeFileSync(join(dir, "run.json"), JSON.stringify(meta, null, 2));
    return new RunStore(dir);
  }

  static open(id: string, root = DEFAULT_RUNS_DIR): RunStore {
    if (!RUN_ID.test(id)) throw new Error("Bad run id");
    const dir = join(root, id);
    if (!existsSync(join(dir, "run.json"))) {
      throw new Error(`No run "${id}"`);
    }
    return new RunStore(dir);
  }

  meta(): RunMeta {
    return JSON.parse(readFileSync(join(this.dir, "run.json"), "utf8"));
  }

  private append(file: string, value: unknown): void {
    appendFileSync(join(this.dir, file), `${JSON.stringify(value)}\n`);
  }

  private readLines<T>(file: string): T[] {
    const path = join(this.dir, file);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  }

  addSnapshot(url: string, fetchedAt: string, text: string): Snapshot {
    const id = createHash("sha256")
      .update(url)
      .update("\0")
      .update(text)
      .digest("hex")
      .slice(0, 16);
    const snapshot: Snapshot = { id, url, fetchedAt, text };
    writeFileSync(
      join(this.dir, "snapshots", `${id}.json`),
      JSON.stringify(snapshot),
    );
    return snapshot;
  }

  snapshot(id: string): Snapshot | undefined {
    if (!/^[0-9a-f]{16}$/.test(id)) return undefined;
    const path = join(this.dir, "snapshots", `${id}.json`);
    return existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as Snapshot)
      : undefined;
  }

  addCandidates(candidates: readonly Candidate[]): void {
    if (candidates.length === 0) return;
    appendFileSync(
      join(this.dir, "candidates.jsonl"),
      candidates.map((c) => `${JSON.stringify(c)}\n`).join(""),
    );
  }

  /** The latest row per key, so a resubmission replaces an earlier one. */
  candidates(): Candidate[] {
    const rows = this.readLines<Candidate>("candidates.jsonl");
    return [...new Map(rows.map((c) => [c.key, c])).values()];
  }

  addVerdict(key: string, verdict: Verdict): void {
    this.append("verdicts.jsonl", { key, ...verdict });
  }

  verdicts(): Map<string, Verdict> {
    const rows = this.readLines<Verdict & { key: string }>("verdicts.jsonl");
    return new Map(
      rows.map(({ key, verdict, reason, digest }) => [
        key,
        { verdict, reason, ...(digest ? { digest } : {}) },
      ]),
    );
  }

  addCollection(collection: StoredCollection): void {
    this.append("collections.jsonl", collection);
  }

  /** The latest attempt per collection: a retry that worked supersedes a failure. */
  collections(): StoredCollection[] {
    const rows = this.readLines<StoredCollection>("collections.jsonl");
    return [...new Map(rows.map((c) => [c.key, c])).values()];
  }

  /** Tool name and outcome only: arguments can hold meeting details. */
  logEvent(event: { tool: string; ok: boolean }): void {
    this.append("events.jsonl", { at: new Date().toISOString(), ...event });
  }

  /** One JSON document per line, ready for an importer to read. */
  writeLines(file: string, rows: readonly unknown[]): void {
    const path = join(this.dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  }

  writeJson(file: string, value: unknown): void {
    writeFileSync(join(this.dir, file), JSON.stringify(value, null, 2));
  }

  readJson<T>(file: string): T | undefined {
    const path = join(this.dir, file);
    return existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as T)
      : undefined;
  }
}
