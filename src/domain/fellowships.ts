/**
 * `inApps` says whether Homegroups and Regroup can show a provider today.
 * Homegroups filters directory rows to AA, NA and CELEBRATE_RECOVERY, and Regroup's
 * "all" search shows any provider but CUSTOM with no mapping for a new one. Other
 * fellowships are collected, and held back from publishing until the apps change.
 */
export const FELLOWSHIPS = {
  AA: { label: "Alcoholics Anonymous", inApps: true },
  NA: { label: "Narcotics Anonymous", inApps: true },
  CELEBRATE_RECOVERY: { label: "Celebrate Recovery", inApps: true },
  AL_ANON: { label: "Al-Anon / Alateen", inApps: false },
  CA: { label: "Cocaine Anonymous", inApps: false },
  CMA: { label: "Crystal Meth Anonymous", inApps: false },
  HA: { label: "Heroin Anonymous", inApps: false },
  MA: { label: "Marijuana Anonymous", inApps: false },
  SMART_RECOVERY: { label: "SMART Recovery", inApps: false },
  RECOVERY_DHARMA: { label: "Recovery Dharma", inApps: false },
  REFUGE_RECOVERY: { label: "Refuge Recovery", inApps: false },
  LIFERING: { label: "LifeRing Secular Recovery", inApps: false },
} as const;

export type Fellowship = keyof typeof FELLOWSHIPS;

export const FELLOWSHIP_IDS = Object.keys(FELLOWSHIPS) as [
  Fellowship,
  ...Fellowship[],
];

export const isFellowship = (value: string): value is Fellowship =>
  Object.hasOwn(FELLOWSHIPS, value);
