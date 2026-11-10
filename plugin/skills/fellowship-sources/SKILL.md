---
name: fellowship-sources
description: Where each recovery fellowship officially publishes its meetings, what counts as an official source, and which directories to refuse. Use when finding or judging a meeting source.
---

# Fellowship sources

Fellowships publish meetings through their own service structure, so start there. Web addresses below are starting points, not guarantees: confirm each one by fetching it.

## By fellowship

| Fellowship         | Structure and where to look                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AA                 | No single public list. Each central office or intergroup runs its own; aa.org lists them. recovery-api's `sync:meetings` owns the national Meeting Guide API. Don't use that API here. |
| NA                 | The seeded `na-bmlt-aggregator` source covers NA's own data. Look further only for an area it doesn't cover.                                                                           |
| Celebrate Recovery | crlocator.com is the current locator (the older locator.crgroups.info has an expired certificate). Individual churches also post their own groups.                                     |
| Al-Anon            | al-anon.org, and local district or area sites.                                                                                                                                         |
| CA, CMA, HA, MA    | ca.org, crystalmeth.org, heroinanonymous.org, marijuana-anonymous.org, and their local areas.                                                                                          |
| SMART Recovery     | meetings.smartrecovery.org is the US finder.                                                                                                                                           |
| Recovery Dharma    | recoverydharma.org.                                                                                                                                                                    |
| Refuge Recovery    | refugerecovery.org.                                                                                                                                                                    |
| LifeRing           | lifering.org.                                                                                                                                                                          |

## Feeds

Many AA intergroups and some other fellowships use the 12 Step Meeting List plugin or Code for Recovery's tools, which can publish the Meeting Guide JSON format:

- A WordPress site using the plugin may answer at `/wp-admin/admin-ajax.php?action=meetings`.
- Sites built on Code for Recovery's sheets may publish a JSON file under `sheets.code4recovery.org/storage/`.

`crawl_site` checks both when it sees signs of them, and reports each feed as `ok`, `locked` or `not-a-feed`.

Many of these feeds are locked, answering 401 or 403 unless given a key. That's the site owner's decision. Record the source as a gap, and don't guess at keys. Whether its public pages are fair to read is a separate question: if `fetch_page` allows them and they show meetings as text, propose it as `html-pages` and note that the feed is locked, so the operator can weigh that when approving it.

A feed is only a feed if fetching it returned a JSON array of meetings.

## Official or not

Official: the fellowship itself, or a service body of it (central office, intergroup, area, region, district, or the group or host church for its own meetings).

Refuse these, however complete they look:

- Treatment-center and rehab marketing sites, including meeting finders on sites such as alcohol.org and recovery.com. They carry ads for treatment, and their data is copied and can be stale.
- Generic local-listing, event and social sites.
- Any site asking people to call a helpline to find a meeting. These numbers often route to paid referrals.

## What makes a source unusable

Report these as gaps rather than working around them:

- A login, CAPTCHA or JavaScript-only page. `fetch_page` sees only what the server sends.
- Access denied, a robots.txt refusal or rate limiting.
- A PDF. It isn't supported yet, so note the URL for the operator.
