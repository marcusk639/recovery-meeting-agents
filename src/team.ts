import { readFileSync } from "node:fs";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { agent as feedCollector } from "./agents/feed-collector/index.js";
import { agent as meetingVerifier } from "./agents/meeting-verifier/index.js";
import { agent as pageExtractor } from "./agents/page-extractor/index.js";
import type { AgentSpec } from "./agents/shared.js";
import { agent as sourceScout } from "./agents/source-scout/index.js";

/** Order matters: it is the order of the roster in the Coordinator's prompt. */
export const AGENTS = {
  "source-scout": sourceScout,
  "feed-collector": feedCollector,
  "page-extractor": pageExtractor,
  "meeting-verifier": meetingVerifier,
} satisfies Record<string, AgentSpec>;

export type TeamRole = keyof typeof AGENTS;
export const ROLES = Object.keys(AGENTS) as TeamRole[];

/** Trailing newlines are stripped so the same prompt yields the same bytes each run. */
export function loadPrompt(file: URL): string {
  return readFileSync(file, "utf8").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

/** Each prompt is read when a run starts, so an edit takes effect on the next run. */
export function loadTeam(): Record<TeamRole, AgentDefinition> {
  const conventions = loadPrompt(
    new URL("./agents/team/prompt.md", import.meta.url),
  );
  return Object.fromEntries(
    ROLES.map((role) => {
      const { promptFile, ...definition } = AGENTS[role] as AgentSpec;
      return [
        role,
        {
          ...definition,
          prompt: `${loadPrompt(promptFile)}\n\n${conventions}`,
        },
      ];
    }),
  ) as Record<TeamRole, AgentDefinition>;
}
