# Alpha — HomeBase Self-Improving Loop

Alpha is the live HomeBase stack running the closed loop:

    observe → evaluate → propose → validate → apply → reflect

Every step is wrapped by Curator default-deny. Nothing applies without a
citation, a rollback, and a measurable expected effect.

## Components

- **Observer** — scans Nucleus Routing Log v0 + Bridge Logs + Lessons DB.
- **Evaluator** — classifies anomalies as `no-op | propose-config-change | propose-lesson | propose-runbook-prune`. Must cite a Lesson, runbook, or Decision log entry. No citation → no-op.
- **Proposer** — emits a Proposal record (see schema below).
- **Curator** — default-deny gate. Approves only when all 5 base conditions hold (see `src/alpha/curator.ts`).
- **Applier** — snapshot → dry-run → diff → apply, with `APPLY_HALT_<code>` on any deviation, plus the 9 stability-resilience rules in §Hardening.
- **Reflector** — writes a Lesson row comparing predicted vs. actual effect from the Amplitude schema v1.

## Proposal record (canonical fields)

- `title`
- `inputs_hash`
- `change_summary`
- `files_or_pages_touched`
- `expected_effect`          (measurable in Amplitude v1)
- `rollback_steps`           (operator-free reversible)
- `risk_class`               (`low | medium | high`)
- `requires`                 (`[Curator] | [Curator, Operator]`)
- `citations`                (Lesson IDs, log URLs, runbook URLs)
- `idempotent`               (boolean; non-idempotent requires guard)

## Curator gate (all must hold)

1. `inputs_hash` does not match any Lesson tagged `do-not-repeat`.
2. Citations exist and resolve.
3. Rollback is concrete and reversible without operator presence.
4. `expected_effect` is measurable in Amplitude schema v1.
5. `risk_class` is `low`, OR Operator co-sign attached.

## Hardening — stability resilience (minimize kinetic feedback)

Enforced by `src/alpha/applier.ts`. "Kinetic feedback penalty" = damage from a Proposal whose ripples exceed its `expected_effect`.

1. **Blast-radius cap.** ≤ 3 files OR ≤ 3 Notion pages OR ≤ 1 DB schema. Else `APP_BLAST_CAP`.
2. **Cooldown window.** Same `inputs_hash` neighborhood may not apply twice within 6h. Else `CUR_COOLDOWN`.
3. **Canary first.** If `files_or_pages_touched > 1`, apply smallest target, wait 1 cycle, then expand. Canary failure halts the rest with `APP_CANARY_FAIL`.
4. **Auto-revert.** If actual vs. expected delta > 2× tolerance, Applier reverts from snapshot. `APP_AUTOREVERT`.
5. **Halt-backoff.** Consecutive halts double cooldown: 6h → 12h → 24h → quarantine.
6. **Quarantine.** 3 halts in 24h freeze the neighborhood for 7 days; Operator-only lift. `APP_QUARANTINE`.
7. **Two-key.** `risk_class: medium` requires Curator AND Operator co-sign.
8. **Idempotency.** Every Applier action must be safe to re-run. Non-idempotent without guard → `CUR_NOT_IDEMPOTENT`.
9. **Shadow apply.** New `inputs_hash` neighborhood → first run writes to sandbox; Reflector grades shadow before live apply.

## Loop SLAs (v0)

- Observer: every 24h.
- Evaluator: immediately after Observer.
- Proposer → Curator: synchronous.
- Applier: only on approval; never unattended for `high` risk.
- Reflector: within 1h of Applier completion or halt.

## Reason code prefixes

- `OBS_*`  observer
- `EVL_*`  evaluator
- `PRP_*`  proposer
- `CUR_*`  curator denial
- `APP_*`  applier halt / auto-revert
- `RFL_*`  reflector

## Out of scope for v0

- Multi-agent Council voting on proposals (track on backlog).
- Auto-merge to `main` without operator co-sign.
- Cross-repo proposals.

## Notion surfaces mirrored here

- Alpha — Next Improvements (pack)
- HomeBase Self-Improving v0 — Build Spec
- Curator Policy v0
- Bridge Self-Update (v0.5, 24h)
- Bridge Risk Register
- Amplitude Instrumentation Schema (v1)
