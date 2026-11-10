import { parseArgs } from "node:util";
import {
  type Fellowship,
  FELLOWSHIP_IDS,
  isFellowship,
} from "./domain/fellowships.js";
import {
  DEFAULT_MAX_BUDGET_USD,
  DEFAULT_MAX_MINUTES,
  DEFAULT_MAX_TURNS,
  DEFAULT_MODEL,
} from "./orchestrator/index.js";
import { PRODUCTION_PROJECT } from "./publish/firestore.js";
import { DEFAULT_MAX_WRITES } from "./publish/index.js";

export type Command =
  | { kind: "help" }
  | { kind: "roles" }
  | {
      kind: "run";
      fellowships: Fellowship[];
      region: string;
      maxBudgetUsd: number;
      maxTurns: number;
      maxMinutes: number;
      model: string;
    }
  | { kind: "status"; runId: string }
  | { kind: "sources"; approve?: string; url?: string; reject?: string }
  | {
      kind: "publish";
      runId: string;
      projectId: string;
      apply: boolean;
      allowDeletes: boolean;
      maxWrites: number;
    };

export function usage(): string {
  return `Usage: pnpm start <command>

  run      --fellowship AA,NA --region "Travis County, Texas"
           [--max-budget-usd ${DEFAULT_MAX_BUDGET_USD}] [--max-turns ${DEFAULT_MAX_TURNS}] [--max-minutes ${DEFAULT_MAX_MINUTES}] [--model ${DEFAULT_MODEL}]
           Runs the agents. Writes only to runs/<id>/ and to proposed sources.
  status   --run <id>
           Counts for a run.
  sources  [--approve <id> --url <its exact url>] [--reject <id>]
           Lists sources, or decides on a proposed one.
  publish  --run <id> [--project ${PRODUCTION_PROJECT}] [--apply]
           [--allow-deletes] [--max-writes ${DEFAULT_MAX_WRITES}]
           Reads the directory and shows what would change. Writes only with --apply.
  roles    Lists the team.

Fellowships: ${FELLOWSHIP_IDS.join(", ")}`;
}

function positiveNumber(
  name: string,
  value: string | undefined,
  fallback: number,
) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`--${name} must be a positive number`);
  }
  return number;
}

/** The region goes into a prompt, so it stays a plain place name. */
const REGION = /^[\p{L}\p{N} ,.'-]{2,80}$/u;

export function parseCommand(argv: readonly string[]): Command {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: [...rest],
    strict: true,
    options: {
      fellowship: { type: "string" },
      region: { type: "string" },
      "max-budget-usd": { type: "string" },
      "max-turns": { type: "string" },
      "max-minutes": { type: "string" },
      model: { type: "string" },
      run: { type: "string" },
      project: { type: "string" },
      apply: { type: "boolean", default: false },
      "allow-deletes": { type: "boolean", default: false },
      "max-writes": { type: "string" },
      approve: { type: "string" },
      url: { type: "string" },
      reject: { type: "string" },
    },
  });

  const requireRun = () => {
    if (!values.run) throw new Error("--run is required");
    return values.run;
  };

  switch (command) {
    case undefined:
    case "help":
    case "--help":
      return { kind: "help" };
    case "roles":
      return { kind: "roles" };
    case "status":
      return { kind: "status", runId: requireRun() };
    case "sources":
      if (values.approve && values.reject) {
        throw new Error("Use one of --approve and --reject");
      }
      if (values.approve && !values.url) {
        throw new Error("--approve needs --url: the source's exact URL");
      }
      return {
        kind: "sources",
        ...(values.approve && values.url
          ? { approve: values.approve, url: values.url }
          : {}),
        ...(values.reject ? { reject: values.reject } : {}),
      };
    case "run": {
      const fellowships = (values.fellowship ?? "")
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
      if (fellowships.length === 0) throw new Error("--fellowship is required");
      const unknown = fellowships.find((f) => !isFellowship(f));
      if (unknown) throw new Error(`Unknown fellowship "${unknown}"`);
      if (!values.region || !REGION.test(values.region)) {
        throw new Error("--region is required, and must be a plain place name");
      }
      return {
        kind: "run",
        fellowships: fellowships as Fellowship[],
        region: values.region,
        maxBudgetUsd: positiveNumber(
          "max-budget-usd",
          values["max-budget-usd"],
          DEFAULT_MAX_BUDGET_USD,
        ),
        maxTurns: positiveNumber(
          "max-turns",
          values["max-turns"],
          DEFAULT_MAX_TURNS,
        ),
        maxMinutes: positiveNumber(
          "max-minutes",
          values["max-minutes"],
          DEFAULT_MAX_MINUTES,
        ),
        model: values.model ?? DEFAULT_MODEL,
      };
    }
    case "publish":
      return {
        kind: "publish",
        runId: requireRun(),
        projectId: values.project ?? PRODUCTION_PROJECT,
        apply: values.apply ?? false,
        allowDeletes: values["allow-deletes"] ?? false,
        maxWrites: positiveNumber(
          "max-writes",
          values["max-writes"],
          DEFAULT_MAX_WRITES,
        ),
      };
    default:
      throw new Error(`Unknown command "${command}"`);
  }
}
