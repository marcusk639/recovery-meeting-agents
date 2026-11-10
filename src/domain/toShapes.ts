import { createHash } from "node:crypto";
import { type Candidate, compact } from "./candidate.js";
import type { Fellowship } from "./fellowships.js";
import { directoryGeohash } from "./identity.js";
import { validPoint } from "./safety.js";
import {
  DirectoryRow,
  HomegroupsMeeting,
  INGESTED_BY,
  RegroupMeeting,
  WEEKDAYS,
} from "./shapes.js";

export interface Point {
  lat: number;
  lng: number;
}

/** Both apps map directory providers to these `MeetingType` values. */
const APP_TYPE: Partial<
  Record<Fellowship, "AA" | "NA" | "Celebrate Recovery">
> = {
  AA: "AA",
  NA: "NA",
  CELEBRATE_RECOVERY: "Celebrate Recovery",
};

/** Homegroups' `generateMeetingHash`, which differs from the directory's id. */
export function homegroupsMeetingId(meeting: {
  name: string;
  day: string;
  time: string;
  link?: string | undefined;
  formattedAddress?: string | undefined;
}): string {
  const key = [
    meeting.name.trim(),
    meeting.day,
    meeting.time,
    meeting.link ?? "",
    meeting.formattedAddress?.trim() ?? "",
  ].join("|");
  return createHash("sha1").update(key).digest("hex").slice(0, 24);
}

/** Homegroups strips a suffix like " - Online" when it stores a meeting; the directory doesn't. */
function homegroupsName(name: string): string {
  const dash = name.indexOf(" - ");
  return (dash > 0 ? name.slice(0, dash) : name).trim();
}

export function toDirectoryRow(candidate: Candidate, point: Point) {
  return DirectoryRow.safeParse(
    compact({
      source: "external",
      provider: candidate.fellowship,
      name: candidate.name,
      day: WEEKDAYS[candidate.day],
      time: candidate.time,
      type: candidate.type,
      format: candidate.format,
      online: candidate.online,
      link: candidate.link,
      onlineNotes: candidate.onlineNotes,
      timezone: candidate.timezone,
      externalId: candidate.externalId,
      sourceRegion: candidate.sourceRegion,
      dataAsOf: candidate.dataAsOf,
      location: compact({
        address: candidate.street,
        city: candidate.city,
        state: candidate.state,
        zip: candidate.zip,
        lat: point.lat,
        lng: point.lng,
        geohash: directoryGeohash(point.lat, point.lng),
      }),
      sourceUrl: candidate.sourceUrl,
      ingestedBy: INGESTED_BY,
      agentSourceId: candidate.collectionKey,
    }),
  );
}

export function toHomegroupsMeeting(candidate: Candidate, point: Point) {
  const name = homegroupsName(candidate.name);
  const day = WEEKDAYS[candidate.day];
  const types = candidate.type ?? candidate.format;
  return HomegroupsMeeting.safeParse(
    compact({
      id: homegroupsMeetingId({
        name,
        day: day ?? "",
        time: candidate.time,
        link: candidate.link,
        formattedAddress: candidate.formattedAddress,
      }),
      name,
      time: candidate.time,
      format: candidate.format ?? "",
      type: APP_TYPE[candidate.fellowship],
      verified: true,
      addedBy: "system",
      day,
      lat: point.lat,
      lng: point.lng,
      geohash: directoryGeohash(point.lat, point.lng),
      online: candidate.online,
      address: candidate.formattedAddress || undefined,
      street: candidate.street,
      city: candidate.city,
      state: candidate.state,
      zip: candidate.zip,
      formattedAddress: candidate.formattedAddress || undefined,
      types,
      country: candidate.country,
      locationName: candidate.locationName,
      link: candidate.link,
      onlineNotes: candidate.onlineNotes,
      apiId: candidate.externalId,
      timezone: candidate.timezone,
      dataAsOf: candidate.dataAsOf,
    }),
  );
}

export function toRegroupMeeting(candidate: Candidate, point: Point) {
  const types = (candidate.format ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return RegroupMeeting.safeParse(
    compact({
      id: candidate.key,
      name: candidate.name,
      time: candidate.time,
      street: candidate.street ?? "",
      city: candidate.city,
      state: candidate.state,
      zip: candidate.zip,
      types: types.length > 0 ? types : undefined,
      lat: point.lat,
      lng: point.lng,
      locationName: candidate.locationName,
      type: APP_TYPE[candidate.fellowship],
      day: WEEKDAYS[candidate.day],
      online: candidate.online,
      link: candidate.link,
      onlineNotes: candidate.onlineNotes ?? "",
      dataAsOf: candidate.dataAsOf,
    }),
  );
}

export interface MeetingShapes {
  directory: DirectoryRow;
  homegroups: HomegroupsMeeting;
  regroup: RegroupMeeting;
}

/** The meeting in all three stored shapes, or null if it doesn't fit one of them. */
export function toShapes(
  candidate: Candidate,
  point: Point,
): MeetingShapes | null {
  // Geohashing throws on an impossible point, and that must hold one row, not end a publish.
  if (!validPoint(point.lat, point.lng)) return null;
  const directory = toDirectoryRow(candidate, point);
  const homegroups = toHomegroupsMeeting(candidate, point);
  const regroup = toRegroupMeeting(candidate, point);
  if (!directory.success || !homegroups.success || !regroup.success) {
    return null;
  }
  return {
    directory: directory.data,
    homegroups: homegroups.data,
    regroup: regroup.data,
  };
}
