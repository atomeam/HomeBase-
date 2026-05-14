// Alpha v0 — runtime thresholds for Curator + Applier hardening.
// Change these in PRs through the Alpha loop itself.

export const ALPHA_CONFIG = {
  blastRadius: {
    maxFiles: 3,
    maxNotionPages: 3,
    maxDatabaseSchemas: 1,
  },
  cooldown: {
    baseHours: 6,
    backoffMultiplier: 2,
    quarantineThresholdHalts24h: 3,
    quarantineDays: 7,
    quarantineMaxDays: 30, // forced operator decision after this
  },
  canary: {
    // when files_or_pages_touched.length > 1, smallest scope first
    waitCycles: 1,
  },
  autoRevert: {
    // multiplier on Proposal.expected_effect.tolerance
    triggerMultiplier: 2,
  },
  loopCaps: {
    proposalsPerObserverCycle: 3,
  },
  curator: {
    // hard default-deny; all 5 conditions enforced in curator.ts
    requireOperatorForRiskAtOrAbove: "medium" as const,
  },
  reflector: {
    maxLagMinutes: 60,
  },
  amplitudeSchemaVersion: "v1",
} as const;

export type AlphaConfig = typeof ALPHA_CONFIG;
