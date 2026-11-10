---
name: meeting-extraction
description: How to turn a meeting list on a web page into submit_candidates entries, with the fields, quoting rules and what to leave out. Use when reading meetings off a page.
---

# Meeting extraction

Each entry passed to `submit_candidates` has these fields, and any other field is rejected.

| Field                  | Rule                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `fellowship`           | The source's fellowship.                                                                                        |
| `name`                 | The meeting's name, exactly as written. Copy it out; don't tidy or expand it.                                   |
| `day`                  | A weekday name or 0 to 6, with 0 for Sunday. One meeting per day: a meeting on Mon and Thu is two entries.      |
| `time`                 | The start time with minutes and AM or PM, such as `7:00 PM`, or 24-hour `19:00`. A page's `7 pm` is `7:00 PM`.  |
| `street`               | Street address with its number, spelled exactly as on the page. Leave out room numbers and directions.          |
| `locationName`         | Optional: the building's name, such as a church, exactly as on the page.                                        |
| `city`, `state`, `zip` | As written. Omit any the page doesn't give.                                                                     |
| `online`               | True when people can join online or by phone.                                                                   |
| `link`                 | A conference link, exactly as it appears on the page, only for a direct meeting link on a conferencing service. |
| `format`               | Optional: open, closed, speaker and so on, as written.                                                          |
| `quote`                | Required: verbatim text from the page containing the meeting's name and start time, ideally its address too.    |

## Quoting

Code checks that the quote is on the page, and that the name and time are inside it. It checks that the day, street, city, state, zip, building and format are on the page, and that the link is on the page and points at a conferencing service. Line breaks and spacing don't matter to the check; words do. Copy text, never paraphrase.

A page that gives a time with no AM or PM, such as `7:00`, can't be traced, so leave that meeting out and count it in your report.

## Days in headings

Lists often put the day in a heading above the rows. Then the quote holds the row, and `day` comes from the nearest heading above it. The verifier will check that heading, so be sure which one applies.

## Leave these out

- Meetings whose day or time the page doesn't state, including "by appointment" and "call for times".
- Anything marked closed, cancelled, suspended or temporarily not meeting, unless it has a way to join online.
- Monthly or occasional events, conventions, service or business meetings, and other fellowships' meetings on the same page.
- Any person's name, phone number or email. If a meeting's name holds one, leave the meeting out.
- Passcodes. If a link only works with a passcode from the page, submit the link without it.

## When the page is unclear

Don't resolve it yourself. If a row could belong to two days, or a time could be AM or PM, leave it out and count it in your report.
