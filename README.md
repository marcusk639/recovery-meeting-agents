# recovery-meeting-agents

A team of AI agents that finds AA, NA and Celebrate Recovery meetings on the public web and turns them into rows for `directoryMeetings`, the Firestore collection that Homegroups and Regroup read through recovery-api's `findMeetings`.

The agents only collect and propose. Nothing reaches Firestore until a person approves the source and runs `publish --apply`, which is separate code the agents can't call.

## How it works

```
run ──► Coordinator ─┬─► source-scout      finds official sources (web search, site crawl)
                     ├─► feed-collector    reads BMLT and Meeting Guide feeds
                     ├─► page-extractor    pulls meetings from HTML pages
                     └─► meeting-verifier  independently re-checks page meetings
                              │
                              ▼
                        runs/<id>/          candidates, verdicts, page snapshots
                              │
sources --approve ──► data/sources.json    a person approves each new source
                              │
publish [--apply] ──► directoryMeetings    gated, geocoded, de-duplicated
```

The team runs on the [Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview). Each role has its own model, prompt and tool list.

| Role               | Model  | Job                                                                                             |
| ------------------ | ------ | ----------------------------------------------------------------------------------------------- |
| Coordinator        | sonnet | Plans the run and delegates. It can't fetch pages or write anything itself.                     |
| `source-scout`     | sonnet | Searches for official sources (intergroups, central offices, service bodies) and proposes them. |
| `feed-collector`   | haiku  | Collects structured feeds: the BMLT aggregator for NA, Meeting Guide JSON for AA.               |
| `page-extractor`   | sonnet | Extracts meetings from a stored page, quoting the text each one came from.                      |
| `meeting-verifier` | opus   | Sees only the stored page and confirms or rejects each extracted meeting.                       |

## Safety model

Meeting listings reach people at a hard moment, and web pages are untrusted, so most of the rules are enforced in code rather than in prompts:

- **Agents never write to Firestore.** Tool access per role is enforced by a hook (`src/orchestrator/policy.ts`). No role has a shell or file tools.
- **Page meetings are traced in code.** A meeting extracted from a page is kept only if its quote, name, time, day and address can be found on the stored page (`src/domain/candidate.ts`). The verifier must also confirm it.
- **People approve sources.** Agents can only propose a source, and approving one requires its exact URL.
- **No contact details or passcodes.** Fields are read from allowlists, every published text field is scanned, and contact details are redacted from source notes. Logs and publish output contain counts only.
- **Refusals are respected.** robots.txt, 401, 403 and 429 responses, CAPTCHAs and locked feeds are reported as gaps, never worked around.
- **The network is guarded.** Requests go only to public addresses (with a DNS-rebinding guard), are throttled and size-limited, and the crawler stays on one site.
- **Publishing is cautious.** It runs as a dry run by default. It never touches rows written by the apps or by other syncs, and deletes need `--allow-deletes` plus a healthy feed, capped at max(5, 10%) of a collection.

## Prerequisites

- Node.js 22 or later, and pnpm
- Claude credentials (`ANTHROPIC_API_KEY` or a stored Claude login) for `run`
- Google Application Default Credentials with access to `recovery-platform-e6cb3` for `publish`
- Firebase CLI, for the emulator tests
- A checkout of `recovery-platform` next to this repo (`../recovery-platform`) for the contract tests. Without it, they are skipped.

## Setup

```bash
pnpm install
pnpm test
```

Optional: set `CRAWLER_CONTACT_URL` to a page about the crawler, so that site owners see it in the user agent.

## Usage

```bash
# Run the team for a region. Writes only to runs/<id>/ and proposed sources.
pnpm start run --fellowship AA,NA --region "Travis County, Texas" --max-budget-usd 5

# Counts for a run
pnpm start status --run <id>

# Review sources; approve or reject one an agent proposed
pnpm start sources
pnpm start sources --approve aa-san-diego-central-office --url "<its exact url>"
pnpm start sources --reject <id>

# Show what would change in the directory (dry run)
pnpm start publish --run <id>

# Write it
pnpm start publish --run <id> --apply [--allow-deletes] [--max-writes 5000]

# List the team
pnpm start roles
```

`run` options: `--max-budget-usd` (default 5), `--max-turns` (40), `--max-minutes` (30) and `--model` (sonnet, the Coordinator's model). `run` exits with code 3 when it collected nothing.

Fellowships: `AA`, `NA` and `CELEBRATE_RECOVERY` publish to the apps. `AL_ANON`, `CA`, `CMA`, `HA`, `MA`, `SMART_RECOVERY`, `RECOVERY_DHARMA`, `REFUGE_RECOVERY` and `LIFERING` are collected but held, because the apps can't show them yet.

Every publish, including a dry run, also writes `runs/<id>/exports/` with each meeting in all three stored shapes: `directoryMeetings`, Homegroups `meetings` and Regroup `meetings`.

## Meeting shapes

`src/domain/shapes.ts` holds a strict schema for each shape, and `src/domain/toShapes.ts` maps a meeting to all three. A meeting that doesn't fit all three is held.

| Collection                         | Day                                                         | Id                                                |
| ---------------------------------- | ----------------------------------------------------------- | ------------------------------------------------- |
| `directoryMeetings` (recovery-api) | weekday name, e.g. `"monday"` (older rows may hold `0`–`6`) | `directoryMeetingId`, or `bmltMeetingId` for BMLT |
| Homegroups `meetings`              | weekday name                                                | `homegroupsMeetingId`                             |
| Regroup `meetings`                 | weekday name                                                | the directory id                                  |

Ids are computed exactly as recovery-api computes them. `src/domain/identity.ts` is a copy of recovery-api's, and a contract test fails if the two drift.

## Development

```bash
pnpm typecheck       # tsc --noEmit
pnpm test            # unit and wiring tests: no network, no model calls
pnpm test:emulator   # publisher against a throwaway Firestore emulator
```

```
src/
  agents/        role prompts and tool lists
  orchestrator/  query options, role policy hook, run deadline
  tools/         MCP tools the agents call (no publisher imports)
  net/           guarded fetcher, HTML to text, site crawler
  feeds/         BMLT and Meeting Guide mappers
  domain/        identity, candidate tracing, safety checks, stored shapes
  store/         run store and source registry
  publish/       gates, duplicates, geocoding, Firestore writes
plugin/skills/   skills the agents load
data/sources.json  the source registry (review its diff after a run)
```

`CLAUDE.md` holds the full rules, the relationship to recovery-platform, known limits and Agent SDK gotchas.

## Known limits

- PDFs and JavaScript-only pages can't be read.
- Geocoding uses the US Census geocoder, so it covers US addresses only.
- Online meetings with no street address have no coordinates, so they're held.
- Nothing schedules runs. How often to run them is still an open decision.

## License

[MIT](LICENSE)
