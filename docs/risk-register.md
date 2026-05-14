# Risk Register (code-side mirror)

Canonical source: Notion **Bridge Risk Register**.

Open items (v0):

- Unattended self-update → operator-only enable flag; Bridge Self-Update Enabled=false by default.
- Proposal-loop runaway → hard cap of 3 Proposals per Observer cycle (`ALPHA_CONFIG.loopCaps`).
- Lesson poisoning → Reflector cannot tag `do-not-repeat` without a halted Applier run or Operator co-sign.
- Auto-revert false positive → every auto-revert writes a Lesson tagged `needs-operator-review`.
- Quarantine drift → weekly Operator audit; auto-expire after 30 days with forced decision.
- Shadow / live divergence → shadow apply must use byte-identical inputs; otherwise `CUR_SHADOW_DRIFT`.
