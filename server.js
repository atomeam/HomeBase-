/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * HomeBase server. Runs alongside the Vite client.
 * - GET  /api/health           — service + bridge status, real version + git sha + building info
 * - POST /api/prompt/:name     — dispatches one of the 6 Alpha prompts to Gemini, server-side only
 *
 * The GEMINI_API_KEY never reaches the client bundle.
 */
import 'dotenv/config';
import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GoogleGenAI } from '@google/genai';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const STARTED_AT = new Date().toISOString();
const VERSION = '0.1.0';

function readGitSha() {
  const fromEnv =
    process.env.GIT_SHA || process.env.K_REVISION || process.env.GITHUB_SHA;
  if (fromEnv) return String(fromEnv).slice(0, 7);
  try {
    const headPath = join(__dirname, '.git', 'HEAD');
    if (!existsSync(headPath)) return 'unknown';
    const head = readFileSync(headPath, 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = join(__dirname, '.git', head.slice(5).trim());
      if (existsSync(refPath))
        return readFileSync(refPath, 'utf8').trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return 'unknown';
  }
}
const GIT_SHA = readGitSha();

// "Building" block. Set HOMEBASE_BUILDING_* envs in deploy to retarget the banner.
const BUILDING = {
  label: process.env.HOMEBASE_BUILDING_LABEL || 'Tier 1 — server + health + tests',
  branch: process.env.HOMEBASE_BUILDING_BRANCH || 'alpha',
  base: process.env.HOMEBASE_BUILDING_BASE || 'main',
  pr_number: Number(process.env.HOMEBASE_BUILDING_PR || 1),
  pr_url: process.env.HOMEBASE_BUILDING_PR_URL || 'https://github.com/atomeam/HomeBase-/pull/1',
  repo_url: 'https://github.com/atomeam/HomeBase-',
};

// The 6 Alpha prompts + 2 utility prompts. Server-side only.
const PROMPTS = {
  observer: `You are Alpha's Observer. Read the last 24h of:
- Nucleus Routing Log v0
- Atomind Bridge Logs
- Any new rows in Lessons DB

Output exactly:
1) Top 5 routing anomalies (id, signature, frequency).
2) Top 3 silent successes worth promoting into Lessons.
3) Any signature that matches an existing Lesson's inputs_hash neighborhood.

No prose. Bullets only. Reason code per item (OBS_*).`,
  evaluator: `You are Alpha's Evaluator. For each Observer item:
- Classify: no-op | propose-config-change | propose-lesson | propose-runbook-prune
- Predict effect (1 sentence) and rollback (1 sentence).
- Cite the Lesson, runbook, or Decision log entry that justifies the call.

If no citation exists, classify as no-op (EVL_NO_CITATION) and list the missing evidence.
Default-deny anything you cannot cite.`,
  proposer: `You are Alpha's Proposer. Take one Evaluator output classified as a propose-*.
Produce a Proposal record using the canonical fields in ALPHA.md.
If risk_class is high, stop and explain what would lower it (PRP_HIGH_RISK_STOP).`,
  curator: `You are Curator. Default-deny.
Approve only if ALL hold:
1) inputs_hash not tagged do-not-repeat.
2) Citations resolve.
3) Rollback is operator-free reversible.
4) expected_effect is measurable in Amplitude v1.
5) risk_class is low, OR Operator co-sign attached.

On denial emit CUR_<single_missing_condition>. No retries this pass.`,
  applier: `You are Alpha's Applier. You have an approved Proposal.
1) Snapshot affected state (file hashes, page revisions, config values).
2) Run change in dry-run; diff to Nucleus Routing Log v0.
3) If dry-run diff matches expected_effect within tolerance, apply.
4) On any deviation: halt, write the snapshot back, emit APPLY_HALT_<short>.

Never apply without a snapshot. Never silence a deviation.

Before step 1, verify ALL of:
- Blast radius is within cap (3 files OR 3 pages OR 1 schema). Else halt APP_BLAST_CAP.
- No prior apply on this inputs_hash neighborhood within the active cooldown. Else halt APP_COOLDOWN.
- If files_or_pages_touched > 1, plan canary: smallest target first, full set deferred 1 cycle.
- If risk_class = medium, require Operator co-sign field present.
- If neighborhood is new, run as shadow apply; do not touch live targets.`,
  reflector: `You are Alpha's Reflector. Applier just finished.
Compare predicted vs. actual effect using Amplitude events.
Write one Lesson row:

- id: L-<next>
- signature: inputs_hash
- outcome: success | partial | failure
- delta: predicted vs. actual, numeric where possible
- generalization: one sentence usable as a future denial reason
- tag: keep | do-not-repeat | needs-operator

If outcome is failure, also propose the smallest config change that would
have prevented it (no execution, just text). Emit RFL_*.`,
  repeatCheck: `Given this inputs_hash and short description, return:
- nearest 3 Lessons by signature similarity
- whether any are tagged do-not-repeat
- a single sentence: "safe to proceed" or "blocked because <Lesson id>".`,
  councilSecondOpinion: `You are not Alpha. Read this Proposal and Curator denial.
In ≤150 words: is the denial correct, over-cautious, or wrong?
Cite the specific Curator Policy v0 clause you are leaning on.
End with one of: UPHOLD | RELAX | OVERRIDE_REQUIRES_OPERATOR.`,
};

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'homebase',
    version: VERSION,
    git_sha: GIT_SHA,
    started_at: STARTED_AT,
    bridge: { configured: Boolean(process.env.ATOMARCADE_NOTION_LOG_DB_ID) },
    gemini: {
      configured: Boolean(process.env.GEMINI_API_KEY),
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    },
    building: BUILDING,
    prompts: Object.keys(PROMPTS),
  });
});

app.post('/api/prompt/:name', async (req, res) => {
  const name = req.params.name;
  const prompt = PROMPTS[name];
  if (!prompt) {
    return res.status(404).json({ error: 'unknown prompt', name });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });
  }
  const input =
    typeof req.body?.input === 'string'
      ? req.body.input
      : JSON.stringify(req.body?.input ?? {});
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const r = await ai.models.generateContent({
      model,
      contents: `${prompt}\n\n---\nInput:\n${input}`,
    });
    res.json({ name, model, output: r.text ?? '' });
  } catch (err) {
    res
      .status(500)
      .json({ error: 'gemini call failed', detail: err?.message || String(err) });
  }
});

if (process.env.SERVE_STATIC === 'true') {
  const distDir = join(__dirname, 'dist');
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
  }
}

app.listen(PORT, () => {
  console.log(`[homebase] listening on :${PORT} sha=${GIT_SHA} v${VERSION} building=${BUILDING.branch}→${BUILDING.base} PR#${BUILDING.pr_number}`);
});
