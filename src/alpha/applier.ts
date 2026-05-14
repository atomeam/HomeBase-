// Alpha v0 — Applier with the 9 stability-resilience hardening rules.
// Pure orchestration: takes a Proposal + ctx, returns an ApplierResult.
// Real side effects (file writes, Notion writes) come from the injected hooks.

import { ALPHA_CONFIG } from "./config";
import type {
  ApplierResult,
  HaltCode,
  NeighborhoodState,
  Proposal,
} from "./types";

export interface ApplierHooks {
  snapshot: (targets: string[]) => Promise<string>; // returns snapshot id
  dryRun: (proposal: Proposal) => Promise<{ predictedDelta: number }>;
  applyLive: (proposal: Proposal, targets: string[]) => Promise<void>;
  applyShadow: (proposal: Proposal) => Promise<void>;
  restoreSnapshot: (snapshotId: string) => Promise<void>;
  measureActual: (proposal: Proposal) => Promise<number>;
}

export interface ApplierContext {
  neighborhood: NeighborhoodState;
  hooks: ApplierHooks;
  now: Date;
}

function blastWithinCap(proposal: Proposal): boolean {
  const cap = ALPHA_CONFIG.blastRadius;
  const targets = proposal.files_or_pages_touched;
  // Conservative: treat the union as ≤ max of any category.
  return (
    targets.length <= cap.maxFiles &&
    targets.length <= cap.maxNotionPages
  );
}

function halt(code: HaltCode, message: string): ApplierResult {
  return { status: "halted", code, message };
}

export async function runApplier(
  proposal: Proposal,
  ctx: ApplierContext,
): Promise<ApplierResult> {
  // Rule 1 — blast-radius cap
  if (!blastWithinCap(proposal)) {
    return halt("APP_BLAST_CAP", "Proposal exceeded blast-radius cap.");
  }

  // Rule 9 — shadow apply for new neighborhoods
  if (!ctx.neighborhood.seen_before) {
    await ctx.hooks.applyShadow(proposal);
    return {
      status: "shadowed",
      message: "First sighting of inputs_hash neighborhood; shadow only.",
    };
  }

  // Rule 3 — canary first when touching > 1 target
  const targets = proposal.files_or_pages_touched.slice();
  const isMulti = targets.length > 1;
  const canary = isMulti ? [targets[0]] : targets;
  const remainder = isMulti ? targets.slice(1) : [];

  const snapshotId = await ctx.hooks.snapshot(targets);
  const { predictedDelta } = await ctx.hooks.dryRun(proposal);

  // Apply canary live
  try {
    await ctx.hooks.applyLive(proposal, canary);
  } catch (err) {
    await ctx.hooks.restoreSnapshot(snapshotId);
    return halt(
      "APP_CANARY_FAIL",
      `Canary apply failed: ${(err as Error).message}`,
    );
  }

  // Measure delta after canary
  const actual = await ctx.hooks.measureActual(proposal);
  const tolerance = proposal.expected_effect.tolerance;
  const driftLimit = tolerance * ALPHA_CONFIG.autoRevert.triggerMultiplier;
  const drift = Math.abs(actual - predictedDelta);

  // Rule 4 — auto-revert circuit breaker
  if (drift > driftLimit) {
    await ctx.hooks.restoreSnapshot(snapshotId);
    return {
      status: "reverted",
      code: "APP_AUTOREVERT",
      snapshot_id: snapshotId,
      delta_observed: actual,
      message: `Drift ${drift.toFixed(3)} exceeded ${driftLimit.toFixed(3)}; reverted.`,
    };
  }

  // Defer the rest by `waitCycles` — caller is responsible for scheduling.
  if (remainder.length) {
    return {
      status: "applied",
      snapshot_id: snapshotId,
      delta_observed: actual,
      message:
        `Canary applied to ${canary[0]}; ${remainder.length} target(s) deferred by ` +
        `${ALPHA_CONFIG.canary.waitCycles} cycle(s).`,
    };
  }

  return {
    status: "applied",
    snapshot_id: snapshotId,
    delta_observed: actual,
  };
}

// Rules 5 & 6 — halt-backoff + quarantine. Caller updates NeighborhoodState
// after each Applier run using this helper.
export function nextNeighborhoodState(
  prev: NeighborhoodState,
  result: ApplierResult,
  now: Date,
): NeighborhoodState {
  const next: NeighborhoodState = { ...prev, seen_before: true };

  if (result.status === "halted" || result.status === "reverted") {
    next.consecutive_halts_24h = prev.consecutive_halts_24h + 1;
    next.current_cooldown_hours =
      prev.current_cooldown_hours * ALPHA_CONFIG.cooldown.backoffMultiplier ||
      ALPHA_CONFIG.cooldown.baseHours;

    if (
      next.consecutive_halts_24h >=
      ALPHA_CONFIG.cooldown.quarantineThresholdHalts24h
    ) {
      const until = new Date(
        now.getTime() +
          ALPHA_CONFIG.cooldown.quarantineDays * 24 * 60 * 60 * 1000,
      );
      next.quarantined_until = until.toISOString();
    }
  } else if (result.status === "applied") {
    next.last_apply_at = now.toISOString();
    next.current_cooldown_hours = ALPHA_CONFIG.cooldown.baseHours;
    next.consecutive_halts_24h = 0;
  }

  return next;
}
