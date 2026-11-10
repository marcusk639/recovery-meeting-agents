# recovery-meeting-agents

Agents that build recovery meeting lists for `directoryMeetings`, the Firestore collection in `recovery-platform-e6cb3` that Homegroups and Regroup read through recovery-api's `findMeetings`. Built on the Claude Agent SDK, modeled on `~/dev/software-dev-team`.

## Commands

```bash
pnpm test                # unit and wiring tests (no network, no model calls)
pnpm test:emulator       # publisher against a throwaway Firestore emulator
pnpm typecheck
pnpm start roles         # the team
pnpm start sources [--approve <id>] [--reject <id>]
pnpm start run --fellowship AA,NA --region "Travis County, Texas" [--max-budget-usd 5]
pnpm start status --run <id>
pnpm start publish --run <id> [--apply] [--allow-deletes]   # dry run unless --apply
```

Env: Claude credentials (`ANTHROPIC_API_KEY` or a stored login) for `run`; Google Application Default Credentials for `publish`; optional `CRAWLER_CONTACT_URL` for the crawler's user agent.

## How a run works

1. `run` starts the Coordinator, which delegates to `source-scout`, `feed-collector`, `page-extractor` and `meeting-verifier` (`src/agents/<role>/`). Everything they find goes to `runs/<id>/` (gitignored). Scouts can add proposed sources to `data/sources.json`, so review that diff.
2. `publish` is separate code that agents can't reach. It applies the gates, geocodes, compares with the directory and writes `directoryMeetings` only with `--apply`.

## Meeting shapes

`src/domain/shapes.ts` holds a strict schema for each stored shape, and `src/domain/toShapes.ts` maps a candidate to all three. A meeting that doesn't fit all three is held as `does-not-fit-shape`. Where a type and the stored data disagree, the schema follows the data.

| Collection                         | Day                                                                          | Address                                             | Id                                                |
| ---------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------- |
| `directoryMeetings` (recovery-api) | `"thursday"` (since recovery-api #207; older rows may hold 0-6, read either) | nested `location`, street in `address`              | `directoryMeetingId`, or `bmltMeetingId` for BMLT |
| Homegroups `meetings`              | `"thursday"` (its entity comment says `"0"`-`"6"`; stored rows disagree)     | flat, full address in `address`, street in `street` | `homegroupsMeetingId`                             |
| Regroup `meetings` (`RatsMeeting`) | `"thursday"`                                                                 | flat, required `street`                             | the directory id                                  |

Each publish, dry run included, writes `runs/<id>/exports/{directoryMeetings,homegroups-meetings,regroup-meetings}.jsonl`. Timestamps are left to whatever writes them. `shapes.contract.test.ts` fails when an upstream type gains a field.

The publisher writes only `directoryMeetings`, which both apps read through `findMeetings`. Don't bulk-load the app files without solving these first:

- **Regroup:** `getCustomMeetings` reads the whole collection on every search, and these rows would appear as custom meetings. Its rules also need a `houseId` these rows don't have.
- **Homegroups:** `onMeetingCreate` runs on every new row and looks up a `groupId` these rows don't have, and the project's billing is off.

## Rules that must hold

- **Agents never write to Firestore.** `src/tools/` must not import the publisher, and no role has a shell or file tools. Roles are enforced by the hook in `src/orchestrator/policy.ts`, not just their prompts. `wiring.test.ts` pins this.
- **Web pages are untrusted, and the readers are people in a hard moment.** A page meeting publishes only if code traces it to the stored page (`src/domain/candidate.ts`), an independent verifier confirms it, and a person approved its source.
- **Agents only propose sources.** Only the `sources` command approves one, and it requires the source's exact URL. Feeds skip the verifier, so an approved feed is trusted for coordinates; links and text are still checked in code.
- **No contact details, no passcodes in notes.** Fields are read from allowlists and the page schema is strict, and code scans every published text field whatever its origin. A one-tap link's `?pwd=` is kept, as upstream does, since it's how that link works. Never log meeting names, addresses or links: `events.jsonl` and `publish` output carry counts only. The Coordinator's text is prompted to do the same, but a model can't be held to that, so it's stripped of control characters.
- **Respect refusals.** robots.txt, 401, 403, 429, CAPTCHAs and locked feeds are reported as gaps, never worked around. When a site locks one feed, `crawl_site` reports every feed it found there as locked, including the cache file the site's own meeting finder loads.
- **The crawler stays on one site.** `crawl_site` (`src/net/crawl.ts`) follows only links on the seed's site, up to depth 3 and 60 pages, from the run's shared fetch budget. Only `source-scout` has it. It returns URLs, counts and short link text, never page text, and other sites it links to are listed for the scout to judge, not crawled.
- **Other writers' rows are not ours.** Publish refreshes or deletes only rows with `ingestedBy: recovery-meeting-agents`, and never touches `source: 'app'`. Deletes need `--allow-deletes`, a healthy feed collection (never page extraction), and at most max(5, 10%) of that collection.
- **Every row shows its age** through `dataAsOf`.
- **Nothing here schedules a run.** The owner decided on 2026-11-08 that no scheduled job updates meetings, and recovery-api's `noScheduledJobs.test.ts` can't see this repo. Cadence is an open decision for the owner, so don't add a cron, workflow or trigger without asking.

## Relationship to recovery-platform

- `src/domain/identity.ts` is an unmodified copy of `recovery-api/src/lib/meetings/identity.ts`, because ids must match exactly. Its only addition is a `// @ts-nocheck` first line, since this repo's `noUncheckedIndexedAccess` rejects upstream's code; keep it when you copy again. `identity.contract.test.ts` fails when `origin/main` changes: copy it again and update any mapper it affects. Don't let a formatter or an edit change what it says.
- `src/feeds/bmlt.ts` follows `recovery-api/src/lib/meetings/sources/bmlt.ts`, and `src/feeds/meetingGuideFeed.ts` follows `sources/meetingGuide.ts`.
- recovery-api's `npm run sync:na` owns national NA, and PR #205's `sync:meetings` would own national AA (not merged as of 2026-11-08). Rows they own are left alone here, so agents fill gaps around them. Homegroups reads AA from the directory only once PR #203 merges.
- recovery-api's prune can delete this repo's AA and CR rows: it removes any `source: 'external'` row not seen for 30 days once a full sweep is healthy. Republish within that window. Its syncs can also merge into a row of ours with the same id, which keeps `ingestedBy`, so a later `--allow-deletes` here could remove a row the national sync still lists until its next run.
- `FELLOWSHIPS[...].inApps` is false for anything but AA, NA and Celebrate Recovery, because Homegroups filters to those three and Regroup has no mapping for others. Those meetings are collected and held. Set `inApps` only after the apps change.

## Known limits

- PDFs and JavaScript-only pages can't be read.
- This repo never deletes page-extracted rows unless the verifier rejects them, so a moved meeting from a page can leave its old row behind.
- Rejecting a source doesn't remove rows already published from it. Query `agentSourceId` to find them.
- A Meeting Guide feed has no count to check against, so a feed that quietly shrinks can lose up to max(5, 10%) per publish with `--allow-deletes`.
- Online meetings with no street address have no coordinates, and `findMeetings` can't return them, so they're held.
- Geocoding uses the US Census geocoder, so it covers US addresses only.

## SDK gotchas (each one cost a live run)

- A tool schema that can't convert to JSON Schema, such as `z.record(z.string(), z.unknown())`, silently empties the server's whole tool list while it still reports `connected`. `runTeam` checks the list at startup, and `wiring.test.ts` checks it against the real CLI.
- Delegations must be forced to the foreground in the hook. A backgrounded agent ends the Coordinator's turn and gets its tools cancelled.
- `strictMcpConfig: true` is what keeps the operator's own connectors, such as Gmail, out of a run.
- `init.tools` doesn't reliably list MCP tools. Use `mcpServerStatus()`.
- A stalled API call isn't limited by the budget or turn caps, so a run has a deadline (`--max-minutes`). A harness interruption reads as "the user" to the model, so prompts say nobody is watching. `run` exits 3 when it collected nothing, because the model can report success regardless.
