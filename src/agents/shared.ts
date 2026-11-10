import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

/** An agent's definition minus its prompt text, which lives in a markdown file. */
export interface AgentSpec extends Omit<
  AgentDefinition,
  "prompt" | "model" | "maxTurns" | "tools"
> {
  promptFile: URL;
  /** Required: each role's tier is deliberate. */
  model: NonNullable<AgentDefinition["model"]>;
  /** Required: the run's turn limit bounds only the coordinator. */
  maxTurns: number;
  /** Required, and enforced by the policy hook as well as the SDK. */
  tools: string[];
}

/** The plugin in this repo (plugin/), which roles preload skills from. */
export const TEAM_PLUGIN_NAME = "meeting-team";
export const TEAM_PLUGIN_DIR = new URL("../../plugin/", import.meta.url);
