// Alpha v0 — canonical Proposal contract.
// Mirrors the schema documented in ALPHA.md.

export type RiskClass = "low" | "medium" | "high";

export type ProposalClassification =
  | "config-change"
  | "lesson"
  | "runbook-prune";

export type ProposalRequires = Array<"Curator" | "Operator">;

export interface Citation {
  kind: "lesson" | "log" | "runbook" | "decision";
  id: string;
  url?: string;
}

export interface Proposal {
  id: string;
  title: string;
  inputs_hash: string;
  change_summary: string;
  files_or_pages_touched: string[];
  expected_effect: {
    metric: string;          // must exist in Amplitude v1
    direction: "increase" | "decrease" | "hold";
    magnitude: number;       // expected delta
    tolerance: number;       // ± window before auto-revert triggers (rule 4)
  };
  rollback_steps: string[];
  risk_class: RiskClass;
  requires: ProposalRequires;
  citations: Citation[];
  classification: ProposalClassification;
  idempotent: boolean;
  idempotency_guard?: string; // required when idempotent === false
  operator_cosign?: {
    user: string;
    at: string; // ISO timestamp
  };
}

export type DenialCode =
  | "CUR_DO_NOT_REPEAT"
  | "CUR_BAD_CITATION"
  | "CUR_NO_ROLLBACK"
  | "CUR_UNMEASURABLE"
  | "CUR_NEEDS_OPERATOR"
  | "CUR_COOLDOWN"
  | "CUR_NOT_IDEMPOTENT"
  | "CUR_LOOP_CAP"
  | "CUR_SHADOW_DRIFT";

export type HaltCode =
  | "APP_BLAST_CAP"
  | "APP_CANARY_FAIL"
  | "APP_AUTOREVERT"
  | "APP_QUARANTINE"
  | "APPLY_HALT_DIFF_DRIFT"
  | "APPLY_HALT_SNAPSHOT_FAIL";

export interface CuratorDecision {
  approved: boolean;
  code?: DenialCode;
  message?: string;
  cooldown_until?: string; // ISO timestamp
}

export interface ApplierResult {
  status: "applied" | "halted" | "reverted" | "shadowed";
  code?: HaltCode;
  snapshot_id?: string;
  delta_observed?: number;
  message?: string;
}

export interface Lesson {
  id: string;            // L-001, L-002, ...
  signature: string;     // inputs_hash
  outcome: "success" | "partial" | "failure";
  delta_predicted: number;
  delta_actual: number;
  generalization: string;
  tag: "keep" | "do-not-repeat" | "needs-operator" | "needs-operator-review";
  created_at: string;
}

export interface NeighborhoodState {
  inputs_hash: string;
  last_apply_at?: string;
  current_cooldown_hours: number;
  consecutive_halts_24h: number;
  quarantined_until?: string;
  seen_before: boolean; // false → shadow apply required
}
