import { describe, expect, it, vi } from "vitest";
import {
  nextNeighborhoodState,
  runApplier,
  type ApplierContext,
  type ApplierHooks,
} from "./applier";
import type { NeighborhoodState, Proposal } from "./types";

function makeHooks(overrides: Partial<ApplierHooks> = {}): ApplierHooks {
  return {
    snapshot: vi.fn(async () => "snap-1"),
    dryRun: vi.fn(async () => ({ predictedDelta: 0.05 })),
    applyLive: vi.fn(async () => {}),
    applyShadow: vi.fn(async () => {}),
    restoreSnapshot: vi.fn(async () => {}),
    measureActual: vi.fn(async () => 0.05),
    ...overrides,
  };
}

const baseProposal: Proposal = {
  id: "P-test",
  title: "t",
  inputs_hash: "h",
  change_summary: "s",
  files_or_pages_touched: ["a"],
  expected_effect: { metric: "m", direction: "increase", magnitude: 0.05, tolerance: 0.02 },
  rollback_steps: ["r"],
  risk_class: "low",
  requires: ["Curator"],
  citations: [{ kind: "log", id: "log-1" }],
  classification: "config-change",
  idempotent: true,
};

function ctx(
  neighborhood: Partial<NeighborhoodState> = {},
  hookOverrides: Partial<ApplierHooks> = {},
): ApplierContext {
  return {
    hooks: makeHooks(hookOverrides),
    neighborhood: {
      inputs_hash: "h",
      current_cooldown_hours: 6,
      consecutive_halts_24h: 0,
      seen_before: true,
      ...neighborhood,
    },
    now: new Date("2026-05-14T12:00:00Z"),
  };
}

describe("runApplier", () => {
  it("halts on blast-radius cap (APP_BLAST_CAP)", async () => {
    const p = { ...baseProposal, files_or_pages_touched: ["a", "b", "c", "d"] };
    const r = await runApplier(p, ctx());
    expect(r.status).toBe("halted");
    expect(r.code).toBe("APP_BLAST_CAP");
  });

  it("shadows on new neighborhood", async () => {
    const c = ctx({ seen_before: false });
    const r = await runApplier(baseProposal, c);
    expect(r.status).toBe("shadowed");
    expect(c.hooks.applyShadow).toHaveBeenCalledTimes(1);
    expect(c.hooks.applyLive).not.toHaveBeenCalled();
  });

  it("halts on canary failure (APP_CANARY_FAIL) and restores snapshot", async () => {
    const p = { ...baseProposal, files_or_pages_touched: ["a", "b"] };
    const c = ctx({}, { applyLive: vi.fn(async () => { throw new Error("boom"); }) });
    const r = await runApplier(p, c);
    expect(r.code).toBe("APP_CANARY_FAIL");
    expect(c.hooks.restoreSnapshot).toHaveBeenCalledTimes(1);
  });

  it("auto-reverts on drift > 2× tolerance (APP_AUTOREVERT)", async () => {
    const c = ctx({}, {
      dryRun: vi.fn(async () => ({ predictedDelta: 0.05 })),
      measureActual: vi.fn(async () => 0.2),
    });
    const r = await runApplier(baseProposal, c);
    expect(r.status).toBe("reverted");
    expect(r.code).toBe("APP_AUTOREVERT");
    expect(c.hooks.restoreSnapshot).toHaveBeenCalledTimes(1);
  });

  it("applies cleanly when within tolerance", async () => {
    const r = await runApplier(baseProposal, ctx());
    expect(r.status).toBe("applied");
  });
});

describe("nextNeighborhoodState", () => {
  const now = new Date("2026-05-14T12:00:00Z");
  const base: NeighborhoodState = {
    inputs_hash: "h",
    current_cooldown_hours: 6,
    consecutive_halts_24h: 0,
    seen_before: true,
  };

  it("doubles cooldown on halt (rule 5)", () => {
    const next = nextNeighborhoodState(base, { status: "halted", code: "APP_BLAST_CAP" }, now);
    expect(next.current_cooldown_hours).toBe(12);
    expect(next.consecutive_halts_24h).toBe(1);
  });

  it("quarantines after 3 halts in 24h (rule 6)", () => {
    const after2 = { ...base, consecutive_halts_24h: 2, current_cooldown_hours: 24 };
    const next = nextNeighborhoodState(after2, { status: "halted", code: "APP_CANARY_FAIL" }, now);
    expect(next.consecutive_halts_24h).toBe(3);
    expect(next.quarantined_until).toBeDefined();
  });

  it("resets cooldown and halt count on successful apply", () => {
    const after2 = { ...base, consecutive_halts_24h: 2, current_cooldown_hours: 24 };
    const next = nextNeighborhoodState(after2, { status: "applied" }, now);
    expect(next.consecutive_halts_24h).toBe(0);
    expect(next.current_cooldown_hours).toBe(6);
    expect(next.last_apply_at).toBe(now.toISOString());
  });

  it("reverted status also counts as a halt for backoff", () => {
    const next = nextNeighborhoodState(base, { status: "reverted", code: "APP_AUTOREVERT" }, now);
    expect(next.consecutive_halts_24h).toBe(1);
    expect(next.current_cooldown_hours).toBe(12);
  });
});
