import { fileURLToPath } from "node:url";
import {
  type Options,
  query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { TEAM_PLUGIN_DIR } from "../agents/shared.js";
import { createFetcher } from "../net/fetcher.js";
import type { RunStore } from "../store/runStore.js";
import type { SourceRegistry } from "../store/sourceRegistry.js";
import { AGENTS, loadPrompt, loadTeam, ROLES } from "../team.js";
import { createHandlers } from "../tools/handlers.js";
import {
  createMeetingServer,
  mcpName,
  SERVER_NAME,
  TOOL_NAMES,
} from "../tools/server.js";
import { createPolicyHooks } from "./policy.js";

const SECRET_ENV =
  /^(GOOGLE_|GCLOUD_|FIREBASE_|FIRESTORE_|MEETING_GUIDE_|RECOVERY_)/;

export const DEFAULT_MODEL = "sonnet";
export const DEFAULT_MAX_TURNS = 40;
export const DEFAULT_MAX_BUDGET_USD = 5;
export const DEFAULT_MAX_MINUTES = 30;

export interface RunOptions {
  store: RunStore;
  registry: SourceRegistry;
  fellowships: readonly string[];
  region: string;
  maxBudgetUsd: number;
  maxTurns: number;
  maxMinutes: number;
  model: string;
  onMessage?: (message: SDKMessage) => void;
}

export interface RunSummary {
  ok: boolean;
  result: string;
  turns: number;
  costUsd: number;
  received: boolean;
}

export function coordinatorPrompt(): string {
  const roster = ROLES.map(
    (role) => `- ${role}: ${AGENTS[role].description}`,
  ).join("\n");
  return loadPrompt(new URL("./prompt.md", import.meta.url)).replace(
    "{{roster}}",
    roster,
  );
}

/** Everything handed to query(), built separately so the wiring can be tested. */
export function buildQueryOptions(options: RunOptions): Options {
  const handlers = createHandlers({
    store: options.store,
    registry: options.registry,
    fetcher: createFetcher(),
    today: () => new Date().toISOString().slice(0, 10),
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !SECRET_ENV.test(name)),
  );
  return {
    agents: loadTeam(),
    systemPrompt: coordinatorPrompt(),
    // Only these exist in the session: no shell, no file tools.
    tools: ["Agent", "WebSearch"],
    allowedTools: ["Agent", "WebSearch", ...TOOL_NAMES.map(mcpName)],
    permissionMode: "dontAsk",
    mcpServers: { [SERVER_NAME]: createMeetingServer(handlers, options.store) },
    // Without this, the operator's own connectors, such as Gmail, join the session.
    strictMcpConfig: true,
    hooks: createPolicyHooks(),
    // No ~/.claude or repo settings, hooks or CLAUDE.md: a run's behavior comes from this repo.
    settingSources: [],
    plugins: [{ type: "local", path: fileURLToPath(TEAM_PLUGIN_DIR) }],
    cwd: options.store.dir,
    env: { ...env, CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1" },
    model: options.model,
    maxTurns: options.maxTurns,
    maxBudgetUsd: options.maxBudgetUsd,
  };
}

/**
 * A server can report "connected" while listing no tools. Agents then improvise
 * around the gap and spend the budget, so a run checks before it starts.
 */
export function missingTools(
  status: readonly { name: string; tools?: { name: string }[] }[],
): string[] {
  const listed = new Set(
    status
      .find((server) => server.name === SERVER_NAME)
      ?.tools?.map((t) => t.name),
  );
  return TOOL_NAMES.filter((name) => !listed.has(name));
}

export function runBrief(options: {
  fellowships: readonly string[];
  region: string;
  runId: string;
}): string {
  return [
    `Run id: ${options.runId}`,
    `Fellowships in scope: ${options.fellowships.join(", ")}`,
    `Region: ${options.region}`,
    "",
    "Build the best meeting list you can for this scope, then report as your output format says.",
  ].join("\n");
}

/** Exit code when a run finished without collecting anything. */
export const EMPTY_RUN_EXIT = 3;

/**
 * The model can end a run "successfully" having done nothing, so the exit code
 * also looks at what the run holds. An unattended job needs that difference.
 */
export function runOutcome(run: { ok: boolean; candidates: number }): {
  code: number;
  warning: string | undefined;
} {
  if (!run.ok) return { code: 1, warning: undefined };
  if (run.candidates > 0) return { code: 0, warning: undefined };
  return {
    code: EMPTY_RUN_EXIT,
    warning:
      "This run collected no meetings. That may be a real gap or a stalled run, so read its report.",
  };
}

export async function runTeam(options: RunOptions): Promise<RunSummary> {
  // A stalled API call has no other limit: budget and turn caps only count finished work.
  const abortController = new AbortController();
  const deadline = setTimeout(
    () => abortController.abort(),
    options.maxMinutes * 60_000,
  );
  const stream = query({
    prompt: runBrief({
      fellowships: options.fellowships,
      region: options.region,
      runId: options.store.meta().id,
    }),
    options: { ...buildQueryOptions(options), abortController },
  });

  const summary: RunSummary = {
    ok: false,
    result: "",
    turns: 0,
    costUsd: 0,
    received: false,
  };
  try {
    for await (const message of stream) {
      options.onMessage?.(message);
      if (message.type === "system" && message.subtype === "init") {
        const missing = missingTools(await stream.mcpServerStatus());
        if (missing.length > 0) {
          summary.result = `The meeting tools didn't load (${missing.join(", ")}), so the run stopped before spending anything.`;
          stream.close();
          break;
        }
      }
      if (message.type !== "result") continue;
      summary.received = true;
      summary.ok = message.subtype === "success" && !message.is_error;
      summary.turns = message.num_turns;
      summary.costUsd = message.total_cost_usd;
      summary.result =
        message.subtype === "success"
          ? message.result
          : [`Run ended: ${message.subtype}`, ...(message.errors ?? [])].join(
              "\n",
            );
    }
  } catch (error) {
    summary.ok = false;
    summary.result = abortController.signal.aborted
      ? `Run stopped at its ${options.maxMinutes} minute limit.`
      : `Run failed: ${(error as Error).message}`;
  } finally {
    clearTimeout(deadline);
  }
  options.store.writeJson("summary.json", summary);
  return summary;
}
