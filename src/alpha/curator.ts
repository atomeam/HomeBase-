// Alpha v0 — Curator default-deny gate.
// Enforces the 5 base conditions in ALPHA.md plus cooldown + idempotency.
// Pure functions: no side effects, no network.

import { ALPHA_CONFIG } from "./config";
import type {
  CuratorDecision,
  Lesson,
  NeighborhoodState,
  Proposal,
} from "./types";

export interface CuratorContext {
  lessons: Lesson[];
  neighborhood: NeighborhoodState;
  amplitudeMetricsAvailable: Set<string>;
  now: Date;
}

export function evaluateProposal(
  proposal: Proposal,
  ctx: CuratorContext,
): CuratorDecision {
  // 1. do-not-repeat
  const blockedLesson = ctx.lessons.find(
    (l) => l.signature === proposal.inputs_hash && l.tag === "do-not-repeat",
  );
  if (blockedLesson) {
    return {
      approved: false,
      code: "CUR_DO_NOT_REPEAT",
      message: `Blocked by lesson ${blockedLesson.id}: ${blockedLesson.generalization}`,
    };
  }

  // 2. citations resolve
  if (!proposal.citations.length || proposal.citations.some((c) => !c.id)) {
    return { approved: false, code: "CUR_BAD_CITATION" };
  }

  // 3. rollback is concrete
  if (!proposal.rollback_steps.length) {
    return { approved: false, code: "CUR_NO_ROLLBACK" };
  }

  // 4. expected_effect is measurable
  if (!ctx.amplitudeMetricsAvailable.has(proposal.expected_effect.metric)) {
    return { approved: false, code: "CUR_UNMEASURABLE" };
  }

  // 5. risk gate — anything above "low" needs Operator co-sign.
  // Applier still gates unattended "high" execution (loop SLA).
  if (proposal.risk_class !== "low" && !proposal.operator_cosign) {
    return { approved: false, code: "CUR_NEEDS_OPERATOR" };
  }

  // Cooldown check (hardening rule 2)
  if (ctx.neighborhood.last_apply_at) {
    const last = new Date(ctx.neighborhood.last_apply_at).getTime();
    const cooldownMs =
      ctx.neighborhood.current_cooldown_hours * 60 * 60 * 1000;
    if (ctx.now.getTime() - last < cooldownMs) {
      const until = new Date(last + cooldownMs).toISOString();
      return { approved: false, code: "CUR_COOLDOWN", cooldown_until: until };
    }
  }

  // Quarantine check (hardening rule 6)
  if (
    ctx.neighborhood.quarantined_until &&
    new Date(ctx.neighborhood.quarantined_until) > ctx.now
  ) {
    return {
      approved: false,
      code: "CUR_COOLDOWN",
      cooldown_until: ctx.neighborhood.quarantined_until,
      message: "Neighborhood is quarantined.",
    };
  }

  // Idempotency check (hardening rule 8)
  if (!proposal.idempotent && !proposal.idempotency_guard) {
    return { approved: false, code: "CUR_NOT_IDEMPOTENT" };
  }

  void ALPHA_CONFIG;

  return { approved: true };
}
