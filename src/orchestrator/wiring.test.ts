import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { RunStore } from "../store/runStore.js";
import { TOOL_NAMES } from "../tools/server.js";
import { SourceRegistry } from "../store/sourceRegistry.js";
import { AGENTS, loadTeam, ROLES } from "../team.js";
import {
  buildQueryOptions,
  coordinatorPrompt,
  missingTools,
  runBrief,
  runOutcome,
} from "./index.js";

const options = () => ({
  store: RunStore.create(
    { id: "r", startedAt: "x", fellowships: ["AA"], region: "TX" },
    mkdtempSync(join(tmpdir(), "meeting-agents-")),
  ),
  registry: new SourceRegistry(),
  fellowships: ["AA"],
  region: "TX",
  maxBudgetUsd: 1,
  maxTurns: 5,
  maxMinutes: 1,
  model: "sonnet",
});

test("a run has no shell or file tools, and no outside configuration", () => {
  const query = buildQueryOptions(options());
  assert.deepEqual(query.tools, ["Agent", "WebSearch"]);
  assert.deepEqual(query.settingSources, []);
  assert.equal(query.permissionMode, "dontAsk");
  assert.equal(query.strictMcpConfig, true);
  for (const allowed of query.allowedTools ?? []) {
    assert.ok(
      allowed === "Agent" ||
        allowed === "WebSearch" ||
        allowed.startsWith("mcp__meetings__"),
      allowed,
    );
  }
});

test("every run has a turn and budget ceiling", () => {
  const query = buildQueryOptions(options());
  assert.equal(query.maxTurns, 5);
  assert.equal(query.maxBudgetUsd, 1);
});

test("Firestore credentials don't reach the agent process", () => {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = "/secret.json";
  process.env.MEETING_GUIDE_API_KEY = "secret";
  try {
    const { env } = buildQueryOptions(options());
    assert.equal(env?.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(env?.MEETING_GUIDE_API_KEY, undefined);
  } finally {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.MEETING_GUIDE_API_KEY;
  }
});

test("no agent's tool list includes a tool that writes to the directory", () => {
  for (const role of ROLES) {
    for (const tool of AGENTS[role].tools) {
      assert.doesNotMatch(tool, /publish|firestore|apply|delete/i);
    }
  }
});

test("the publisher isn't reachable from the agent code", () => {
  const server = readFileSync(
    new URL("../tools/server.ts", import.meta.url),
    "utf8",
  );
  const handlers = readFileSync(
    new URL("../tools/handlers.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(server, /publish\/(index|apply|firestore)/);
  assert.doesNotMatch(
    handlers,
    /publish\/(index|apply|firestore)|firebase-admin/,
  );
});

test("prompts compose: each role carries the team's conventions", () => {
  const team = loadTeam();
  for (const role of ROLES) {
    assert.match(team[role].prompt, /<handoff>/);
    assert.match(team[role].prompt, /<safety>/);
  }
  const coordinator = coordinatorPrompt();
  for (const role of ROLES) assert.match(coordinator, new RegExp(`- ${role}:`));
  assert.doesNotMatch(coordinator, /\{\{/);
});

test("every skill a role preloads ships in the plugin", () => {
  for (const role of ROLES) {
    for (const skill of AGENTS[role].skills ?? []) {
      const [plugin, name] = skill.split(":");
      assert.equal(plugin, "meeting-team");
      assert.ok(
        existsSync(
          fileURLToPath(
            new URL(`../../plugin/skills/${name}/SKILL.md`, import.meta.url),
          ),
        ),
        skill,
      );
    }
  }
});

test("nothing in this repo schedules a run", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  for (const command of Object.values(manifest.scripts)) {
    assert.doesNotMatch(command, /cron|schedule/i);
  }
});

test("the SDK really lists every meeting tool, and no connector joins", async () => {
  // Starts the real CLI up to its init message, before any model call.
  const stream = query({
    prompt: "unused",
    options: { ...buildQueryOptions(options()), model: "haiku" },
  });
  for await (const message of stream) {
    if (message.type === "system" && message.subtype === "init") {
      const status = await stream.mcpServerStatus();
      assert.deepEqual(missingTools(status), []);
      assert.deepEqual(
        status.map((server) => server.name),
        ["meetings"],
      );
      break;
    }
  }
  stream.close();
});

test("a server listing nothing is caught", () => {
  assert.equal(
    missingTools([{ name: "meetings", tools: [] }]).length,
    TOOL_NAMES.length,
  );
  assert.equal(missingTools([]).length, TOOL_NAMES.length);
});

test("the Coordinator knows nobody is there to answer it", () => {
  assert.match(coordinatorPrompt(), /No person is watching a run/);
  assert.match(coordinatorPrompt(), /Never pause/);
});

test("a run that found nothing doesn't count as a success", () => {
  assert.deepEqual(runOutcome({ ok: true, candidates: 3 }), {
    code: 0,
    warning: undefined,
  });
  const empty = runOutcome({ ok: true, candidates: 0 });
  assert.equal(empty.code, 3);
  assert.match(empty.warning ?? "", /no meetings/i);
  assert.equal(runOutcome({ ok: false, candidates: 3 }).code, 1);
});

test("the brief carries the run's scope", () => {
  const brief = runBrief({
    fellowships: ["AA", "NA"],
    region: "Travis County, Texas",
    runId: "r1",
  });
  assert.match(brief, /AA, NA/);
  assert.match(brief, /Travis County, Texas/);
});
