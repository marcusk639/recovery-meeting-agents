#!/usr/bin/env node
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type Command, parseCommand, usage } from "./cli.js";
import { FELLOWSHIPS } from "./domain/fellowships.js";
import { createHandlers } from "./tools/handlers.js";
import { createFetcher } from "./net/fetcher.js";
import { runOutcome, runTeam } from "./orchestrator/index.js";
import { publish } from "./publish/index.js";
import { newRunId, RunStore } from "./store/runStore.js";
import { SourceRegistry } from "./store/sourceRegistry.js";
import { AGENTS, ROLES } from "./team.js";

const out = (text: string) => process.stdout.write(`${text}\n`);
const err = (text: string) => process.stderr.write(`${text}\n`);

/** Model text can quote a page, so it can't be allowed to drive the terminal. */
const printable = (text: string) =>
  text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

/** Shows the shape of a run. Subagents' tool inputs stay out: they hold meeting details. */
function render(message: SDKMessage): void {
  if (message.type !== "assistant") return;
  const inSubagent = message.parent_tool_use_id !== null;
  for (const block of message.message.content) {
    if (block.type === "tool_use") {
      const input = block.input as { subagent_type?: string };
      out(
        `${inSubagent ? "  " : ""}▸ ${block.name}${input.subagent_type ? ` → ${input.subagent_type}` : ""}`,
      );
    } else if (block.type === "text" && !inSubagent && block.text.trim()) {
      out(printable(block.text));
    }
  }
}

async function execute(command: Command): Promise<number> {
  switch (command.kind) {
    case "help":
      out(usage());
      return 0;

    case "roles":
      out(`coordinator [${"sonnet"}]`);
      for (const role of ROLES) {
        out(`${role} [${AGENTS[role].model}]\n  ${AGENTS[role].description}`);
      }
      return 0;

    case "sources": {
      const registry = new SourceRegistry();
      if (command.approve) registry.approve(command.approve, command.url ?? "");
      if (command.reject) registry.setStatus(command.reject, "rejected");
      for (const source of registry.list()) {
        out(
          `${source.status.padEnd(9)} ${source.id}  [${source.fellowship}, ${source.kind}]  ${source.url}`,
        );
      }
      return 0;
    }

    case "status": {
      const store = RunStore.open(command.runId);
      const handlers = createHandlers({
        store,
        registry: new SourceRegistry(),
        fetcher: createFetcher(),
        today: () => new Date().toISOString().slice(0, 10),
      });
      out(JSON.stringify(handlers.runStatus(), null, 2));
      return 0;
    }

    case "run": {
      const id = newRunId();
      const store = RunStore.create({
        id,
        startedAt: new Date().toISOString(),
        fellowships: command.fellowships,
        region: command.region,
      });
      out(`Run ${id}: ${command.fellowships.join(", ")} in ${command.region}`);
      const held = command.fellowships.filter((f) => !FELLOWSHIPS[f].inApps);
      if (held.length > 0) {
        out(
          `Note: the apps can't show ${held.join(", ")} yet, so publishing holds them.`,
        );
      }
      const summary = await runTeam({
        store,
        registry: new SourceRegistry(),
        fellowships: command.fellowships,
        region: command.region,
        maxBudgetUsd: command.maxBudgetUsd,
        maxTurns: command.maxTurns,
        maxMinutes: command.maxMinutes,
        model: command.model,
        onMessage: render,
      });
      out(
        `\nRun ${id}: ${summary.turns} turns, $${summary.costUsd.toFixed(2)}. Nothing was published.`,
      );
      out(`Review it with: pnpm start publish --run ${id}`);
      if (!summary.ok) {
        err(printable(summary.result) || "The run ended without a result.");
      }
      const { code, warning } = runOutcome({
        ok: summary.ok,
        candidates: store.candidates().length,
      });
      if (warning) err(warning);
      return code;
    }

    case "publish": {
      const summary = await publish({
        store: RunStore.open(command.runId),
        registry: new SourceRegistry(),
        projectId: command.projectId,
        apply: command.apply,
        allowDeletes: command.allowDeletes,
        maxWrites: command.maxWrites,
      });
      out(JSON.stringify(summary, null, 2));
      out(
        summary.applied
          ? "Applied."
          : "Dry run: nothing was written. Details are in the run's plan.json. Add --apply to write.",
      );
      return 0;
    }
  }
}

async function main(): Promise<number> {
  let command: Command;
  try {
    command = parseCommand(process.argv.slice(2));
  } catch (error) {
    err(`${(error as Error).message}\n\n${usage()}`);
    return 2;
  }
  try {
    return await execute(command);
  } catch (error) {
    err((error as Error).message);
    return 1;
  }
}

process.exitCode = await main();
