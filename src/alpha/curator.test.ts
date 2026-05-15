import { describe, expect, it } from "vitest";
import { evaluateProposal, type CuratorContext } from "./curator";
import type { Lesson, Proposal } from "./types";

const baseProposal: Proposal = {
  id: "P-test",
  title: "tweak X",
  inputs_hash: "hash-a",
  change_summary: "lower routing threshold by 10%",
  files_or_pages_touched: ["src/foo.ts"],
  expected_effect: {
    metric: "routing.success_rate",
    direction: "increase",
    magnitude: 0.05,
    tolerance: 0.02,
  },
  rollback_steps: ["restore previous threshold value"],
  risk_class: "low",
  requires: ["Curator"],
  citations: [{ kind: "lesson", id: "L-000" }],
  classification: "config-change",
  idempotent: true,
};

function baseCtx(overrides: Partial<CuratorContext> = {}): CuratorContext {
  return {
    lessons: [],
    neighborhood: {
      inputs_hash: "hash-a",
      current_cooldown_hours: 6,
      consecutive_halts_24h: 0,
      seen_before: true,
    },
    amplitudeMetricsAvailable: new Set(["routing.success_rate"]),
    now: new Date("2026-05-14T12:00:00Z"),
    ...overrides,
  };
}

describe("evaluateProposal", () => {
  it("approves a clean low-risk proposal", () => {
    expect(evaluateProposal(baseProposal, baseCtx()).approved).toBe(true);
  });

  it("denies do-not-repeat (CUR_DO_NOT_REPEAT)", () => {
    const lesson: Lesson = {
      id: "L-001",
      signature: "hash-a",
      outcome: "failure",
      delta_predicted: 0,
      delta_actual: 0,
      generalization: "already burned",
      tag: "do-not-repeat",
      created_at: "2026-05-13T00:00:00Z",
    };
    const d = evaluateProposal(baseProposal, baseCtx({ lessons: [lesson] }));
    expect(d.approved).toBe(false);
    expect(d.code).toBe("CUR_DO_NOT_REPEAT");
  });

  it("denies missing citations (CUR_BAD_CITATION)", () => {
    const d = evaluateProposal({ ...baseProposal, citations: [] }, baseCtx());
    expect(d.code).toBe("CUR_BAD_CITATION");
  });

  it("denies missing rollback (CUR_NO_ROLLBACK)", () => {
    const d = evaluateProposal({ ...baseProposal, rollback_steps: [] }, baseCtx());
    expect(d.code).toBe("CUR_NO_ROLLBACK");
  });

  it("denies unmeasurable metric (CUR_UNMEASURABLE)", () => {
    const d = evaluateProposal(baseProposal, baseCtx({ amplitudeMetricsAvailable: new Set() }));
    expect(d.code).toBe("CUR_UNMEASURABLE");
  });

  it("denies high risk without operator co-sign (CUR_NEEDS_OPERATOR)", () => {
    const d = evaluateProposal({ ...baseProposal, risk_class: "high" }, baseCtx());
    expect(d.code).toBe("CUR_NEEDS_OPERATOR");
  });

  it("denies medium risk without operator co-sign (CUR_NEEDS_OPERATOR)", () => {
    const d = evaluateProposal({ ...baseProposal, risk_class: "medium" }, baseCtx());
    expect(d.code).toBe("CUR_NEEDS_OPERATOR");
  });

  it("approves medium risk with operator co-sign", () => {
    const d = evaluateProposal(
      { ...baseProposal, risk_class: "medium", operator_cosign: { user: "user-40", at: "2026-05-14T11:59:00Z" } },
      baseCtx(),
    );
    expect(d.approved).toBe(true);
  });

  it("approves high risk with operator co-sign (Curator level)", () => {
    const d = evaluateProposal(
      { ...baseProposal, risk_class: "high", operator_cosign: { user: "user-40", at: "2026-05-14T11:59:00Z" } },
      baseCtx(),
    );
    expect(d.approved).toBe(true);
  });

  it("denies during active cooldown (CUR_COOLDOWN)", () => {
    const d = evaluateProposal(
      baseProposal,
      baseCtx({
        neighborhood: {
          inputs_hash: "hash-a",
          last_apply_at: "2026-05-14T10:00:00Z",
          current_cooldown_hours: 6,
          consecutive_halts_24h: 0,
          seen_before: true,
        },
      }),
    );
    expect(d.code).toBe("CUR_COOLDOWN");
    expect(d.cooldown_until).toBeDefined();
  });

  it("denies during active quarantine (CUR_COOLDOWN)", () => {
    const d = evaluateProposal(
      baseProposal,
      baseCtx({
        neighborhood: {
          inputs_hash: "hash-a",
          current_cooldown_hours: 24,
          consecutive_halts_24h: 3,
          quarantined_until: "2026-05-20T00:00:00Z",
          seen_before: true,
        },
      }),
    );
    expect(d.code).toBe("CUR_COOLDOWN");
  });

  it("denies non-idempotent without guard (CUR_NOT_IDEMPOTENT)", () => {
    const d = evaluateProposal({ ...baseProposal, idempotent: false }, baseCtx());
    expect(d.code).toBe("CUR_NOT_IDEMPOTENT");
  });

  it("approves non-idempotent when guard provided", () => {
    const d = evaluateProposal(
      { ...baseProposal, idempotent: false, idempotency_guard: "check current threshold first" },
      baseCtx(),
    );
    expect(d.approved).toBe(true);
  });
});
