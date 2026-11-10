import { z } from "zod";

/**
 * What each collection stores, as this repo must write it. These follow stored
 * documents where they differ from the upstream types: Homegroups' entity comments
 * `day` as "0"-"6", but its stored documents hold "thursday". `shapes.contract.test.ts`
 * fails when an upstream type gains a field this repo hasn't considered.
 *
 * Timestamps are absent because the writer sets them, as server timestamps.
 */

/** Marks rows this repo wrote, which are the only ones it refreshes or deletes. */
export const INGESTED_BY = "recovery-meeting-agents";

const HH_MM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LAT = z.number().min(-90).max(90);
const LNG = z.number().min(-180).max(180);
const HTTP_URL = z.url({ protocol: /^https?$/ });
const TEXT = z.string().min(1);

export const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** The types both apps' `MeetingType` share with a directory provider. */
export const APP_MEETING_TYPES = ["AA", "NA", "Celebrate Recovery"] as const;

/** recovery-api `DirectoryMeeting`, plus this repo's provenance fields. */
export const DirectoryRow = z.strictObject({
  source: z.literal("external"),
  provider: z.enum(["AA", "NA", "CELEBRATE_RECOVERY"]),
  name: TEXT,
  // A name since recovery-api #207. Older rows may hold 0-6 until migrated.
  day: z.enum(WEEKDAYS),
  time: HH_MM,
  type: TEXT.optional(),
  format: TEXT.optional(),
  online: z.boolean(),
  link: HTTP_URL.optional(),
  onlineNotes: TEXT.optional(),
  timezone: TEXT.optional(),
  externalId: TEXT.optional(),
  sourceRegion: TEXT.optional(),
  dataAsOf: DATE,
  location: z.strictObject({
    address: TEXT.optional(),
    city: TEXT.optional(),
    state: TEXT.optional(),
    zip: TEXT.optional(),
    lat: LAT,
    lng: LNG,
    geohash: z.string().length(10),
  }),
  sourceUrl: HTTP_URL,
  ingestedBy: z.literal(INGESTED_BY),
  agentSourceId: TEXT,
});
export type DirectoryRow = z.infer<typeof DirectoryRow>;

/** A document in Homegroups' `meetings`, in the form its scraped rows take. */
export const HomegroupsMeeting = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{24}$/),
  name: TEXT,
  time: HH_MM,
  format: z.string(),
  type: z.enum(APP_MEETING_TYPES),
  verified: z.literal(true),
  addedBy: z.literal("system"),
  day: z.enum(WEEKDAYS),
  lat: LAT,
  lng: LNG,
  geohash: TEXT,
  online: z.boolean(),
  /** Homegroups keeps the full address here, and the street in `street`. */
  address: TEXT.optional(),
  street: TEXT.optional(),
  city: TEXT.optional(),
  state: TEXT.optional(),
  zip: TEXT.optional(),
  formattedAddress: TEXT.optional(),
  types: TEXT.optional(),
  country: TEXT.optional(),
  locationName: TEXT.optional(),
  link: HTTP_URL.optional(),
  onlineNotes: TEXT.optional(),
  apiId: TEXT.optional(),
  timezone: TEXT.optional(),
  dataAsOf: DATE,
});
export type HomegroupsMeeting = z.infer<typeof HomegroupsMeeting>;

/** A `RatsMeeting`, as Regroup's `meetings` and its `findMeetings` use it. */
export const RegroupMeeting = z.strictObject({
  id: TEXT,
  name: TEXT,
  time: HH_MM,
  /** Required upstream, and empty when a meeting has no street. */
  street: z.string(),
  city: TEXT.optional(),
  state: TEXT.optional(),
  zip: TEXT.optional(),
  types: z.array(TEXT).optional(),
  lat: LAT,
  lng: LNG,
  locationName: TEXT.optional(),
  type: z.enum(APP_MEETING_TYPES),
  day: z.enum(WEEKDAYS),
  online: z.boolean(),
  link: HTTP_URL.optional(),
  /** Required upstream, and empty when there are none. */
  onlineNotes: z.string(),
  dataAsOf: DATE,
});
export type RegroupMeeting = z.infer<typeof RegroupMeeting>;
