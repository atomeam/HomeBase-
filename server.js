/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * HomeBase server. Runs alongside the Vite client.
 * - GET  /api/health           — service + bridge status, real version + git sha + building info
 * - GET  /api/logs             — recent activity from homebase-logs.jsonl
 * - POST /api/prompt/:name     — dispatches one of the 6 Alpha prompts to Gemini, server-side only
 * - POST /api/run/:script      — execute HomeBase scripts (observer, evaluator, proposer, etc.)
 * - POST /api/run/alpha-loop   — execute full Alpha loop (Observer → Evaluator → Proposer)
 *
 * The GEMINI_API_KEY never reaches the client bundle.
 */
import 'dotenv/config';
import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { runAlphaLoop } from './src/alpha/orchestrator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const STARTED_AT = new Date().toISOString();
const VERSION = '0.1.0';

// Health history ring buffer (in-memory)
const HEALTH_HISTORY_MAX = 50;
const healthHistory = [];
let lastHealthOk = null; // Track status transitions for alerting

// Health history persistence (optional JSONL file)
const HEALTH_HISTORY_PATH = process.env.HOMEBASE_HEALTH_HISTORY_PATH || 'C:\\AtomArcade\\health-history.jsonl';

function addHealthSnapshot(snapshot) {
  const entry = {
    timestamp: snapshot.timestamp || new Date().toISOString(),
    ok: snapshot.ok,
    version: snapshot.version,
    checks: snapshot.checks,
  };
  
  // Check for status transition (alerting)
  if (lastHealthOk !== null && lastHealthOk !== snapshot.ok) {
    entry.statusTransition = {
      from: lastHealthOk,
      to: snapshot.ok,
      at: entry.timestamp,
    };
  }
  lastHealthOk = snapshot.ok;
  
  // Add to ring buffer
  healthHistory.push(entry);
  if (healthHistory.length > HEALTH_HISTORY_MAX) {
    healthHistory.shift();
  }
  
  // Persist to JSONL (sync, fire-and-forget)
  try {
    if (HEALTH_HISTORY_PATH) {
      const fs = require('node:fs');
      const line = JSON.stringify(entry) + '\n';
      fs.appendFileSync(HEALTH_HISTORY_PATH, line);
    }
  } catch {
    // Ignore persistence errors silently
  }
  
  return entry;
}

function getFlappingStatus() {
  const recent = healthHistory.slice(-10);
  if (recent.length < 3) return null;
  
  const failures = recent.filter(h => !h.ok).length;
  if (failures >= 3) return 'flapping';
  
  const firstFail = recent.find(h => !h.ok);
  const lastSuccess = [...recent].reverse().find(h => h.ok);
  
  return {
    firstFailureAt: firstFail?.timestamp || null,
    lastSuccessAt: lastSuccess?.timestamp || null,
    recentFailures: failures,
    totalInWindow: recent.length,
  };
}

// Incident tracking for Notion write-back
let lastIncidentWritten = null; // timestamp of last incident
let lastIncidentSignature = null; // deduplication signature
let lastNotionPageId = null; // Page ID of last created incident

// Map of open incidents by signature (for recovery resolution)
const openIncidents = new Map(); // signature -> { pageId, openedAt, title }

// All incidents for correlation analysis (including resolved)
const allIncidents = []; // { homebaseSha, bridgeVersion, status, openedAt, resolvedAt, duration }

// Current versions (for correlation)
const currentVersions = {
  homebaseSha: GIT_SHA,
  bridgeVersion: null, // set after first bridge health fetch
};

function getSignature(data, isFlapping) {
  return JSON.stringify({
    ok: data.ok,
    isFlapping,
    failedChecks: Object.entries(data.checks || {})
      .filter(([_, v]) => !v.ok)
      .map(([k]) => k)
      .sort(),
  });
}

function shouldWriteIncident(currentData, isFlapping) {
  // Rate limit: at most 1 incident per unique failure signature per 30 minutes
  const signature = getSignature(currentData, isFlapping);
  
  // If same signature, don't write again within 30 min
  if (signature === lastIncidentSignature && lastIncidentWritten) {
    const timeSinceLast = Date.now() - new Date(lastIncidentWritten).getTime();
    if (timeSinceLast < 30 * 60 * 1000) {
      return { should: false, reason: 'rate-limited' };
    }
  }
  
  return { should: true, signature };
}

async function writeIncidentToNotion(incident) {
  try {
    const { Client } = await import('@notionhq/client');
    const notion = new Client({ apiKey: process.env.NOTION_API_KEY });
    const dbId = process.env.ATOMARCADE_NOTION_LOG_DB_ID;
    
    if (!dbId) {
      console.log('[incident] No ATOMARCADE_NOTION_LOG_DB_ID, skipping');
      return { written: false, reason: 'no-db' };
    }
    
    // Build detail with version info inline
    const versionInfo = `HomeBaseSHA=${incident.homebaseSha || 'unknown'} BridgeVersion=${incident.bridgeVersion || 'unknown'} BridgeURL=${incident.bridgeBaseUrl || 'n/a'}`;
    const fullDetail = `${versionInfo} | ${incident.detail}`;
    
    const page = await notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        'Kind': { select: { name: 'Incident' } },
        'Timestamp': { rich_text: [{ text: { content: incident.timestamp } }] },
        'Status': { select: { name: incident.ok ? 'Resolved' : 'Open' } },
        'Detail': { rich_text: [{ text: { content: fullDetail } }] },
        'Source': { rich_text: [{ text: { content: 'HomeBase Telemetry' } }] },
      },
    });
    
    console.log(`[incident] Written to Notion: ${incident.title} (HB:${incident.homebaseSha} BR:${incident.bridgeVersion})`);
    return { written: true, pageId: page.id };
  } catch (err) {
    console.error('[incident] Notion write failed:', err.message);
    return { written: false, error: err.message };
  }
}

async function resolveIncidentInNotion(signature) {
  try {
    const entry = openIncidents.get(signature);
    if (!entry) {
      console.log('[incident] No open incident to resolve for signature');
      return { resolved: false, reason: 'not-found' };
    }
    
    const { Client } = await import('@notionhq/client');
    const notion = new Client({ apiKey: process.env.NOTION_API_KEY });
    
    const resolveTime = new Date().toISOString();
    
    // Calculate duration
    let duration = 'unknown';
    try {
      const opened = new Date(entry.openedAt).getTime();
      const resolved = new Date(resolveTime).getTime();
      const diffMs = resolved - opened;
      const diffMins = Math.round(diffMs / 60000);
      duration = diffMins < 1 ? '<1 min' : `${diffMins} min`;
    } catch {
      // ignore
    }
    
    // Build version info for resolve
    const resolveInfo = `Resolved at ${resolveTime} (Duration: ${duration} HomeBaseSHA=${GIT_SHA})`;
    
    await notion.pages.update({
      page_id: entry.pageId,
      properties: {
        'Status': { select: { name: 'Resolved' } },
        'Detail': { rich_text: [{ text: { content: `${entry.detail || ''} | ${resolveInfo}` } }] },
      },
    });
    
    console.log(`[incident] Resolved incident: ${entry.pageId} (${duration})`);
    openIncidents.delete(signature);
    
    // Mark in correlation tracker
    for (const inc of allIncidents) {
      if (inc.status === 'Open' && inc.openedAt === entry.openedAt) {
        inc.status = 'Resolved';
        inc.resolvedAt = resolveTime;
        inc.duration = duration;
        break;
      }
    }
    
    // Persist resolved to JSONL (append new row)
    appendIncidentLog({
      homebaseSha: entry.homebaseSha || 'unknown',
      bridgeVersion: entry.bridgeVersion || 'unknown',
      status: 'Resolved',
      openedAt: entry.openedAt,
      resolvedAt: resolveTime,
      duration,
    });
    
    // Invalidate correlation cache
    correlationCache.timestamp = 0;
    
    return { resolved: true, duration };
  } catch (err) {
    console.error('[incident] Resolve failed:', err.message);
    return { resolved: false, error: err.message };
  }
}

async function handleHealthTransition(bridgeData, flappingStatus) {
  const isFlapping = flappingStatus === 'flapping';
  const signature = getSignature(bridgeData, isFlapping);
  
  // Recovery: ok flips false → true AND we have an open incident
  const isRecovery = lastHealthOk === false && bridgeData.ok === true;
  
  if (isRecovery) {
    // Try to resolve the matching incident
    if (process.env.NOTION_INCIDENT_LOG_ENABLED === 'true') {
      const result = await resolveIncidentInNotion(signature);
      if (result.resolved) {
        // Clear tracking
        lastIncidentSignature = null;
        lastIncidentWritten = null;
        lastNotionPageId = null;
      }
    }
    return;
  }
  
  // New failure: ok flips true → false, or flapping starts
  const isTransitionToBad = lastHealthOk === true && bridgeData.ok === false;
  const isFlappingStart = !lastIncidentSignature && isFlapping;
  
  if (!isTransitionToBad && !isFlappingStart) return;
  
  // Check guard
  if (process.env.NOTION_INCIDENT_LOG_ENABLED !== 'true') {
    console.log('[incident] NOTION_INCIDENT_LOG_ENABLED not true, skipping write');
    return;
  }
  
  const { should, reason } = shouldWriteIncident(bridgeData, isFlapping);
  if (!should) {
    console.log(`[incident] Skipping: ${reason}`);
    return;
  }
  
  // Build incident payload
  const failedChecks = Object.entries(bridgeData.checks || {})
    .filter(([_, v]) => !v.ok)
    .map(([k, v]) => `${k}: ${v.detail} (${v.latencyMs}ms)`);
  
  // Extract bridge version from response
  const bridgeVersion = bridgeData.version || bridgeData.gitSha || 'unknown';
  
  const incident = {
    timestamp: new Date().toISOString(),
    title: isFlapping ? 'WARNING: Connection Flapping' : 'CRITICAL: System Outage',
    detail: failedChecks.length > 0 ? failedChecks.join('; ') : 'Overall health check failed',
    ok: bridgeData.ok,
    source: 'bridge-health',
    bridgeBaseUrl: process.env.BRIDGE_BASE_URL,
    homebaseSha: GIT_SHA,
    bridgeVersion: bridgeVersion,
    telemetry: {
      isFlapping,
      historyLength: healthHistory.length,
    },
  };
  
  // Write to Notion
  const result = await writeIncidentToNotion(incident);
  
  if (result.written) {
    lastIncidentWritten = incident.timestamp;
    lastIncidentSignature = signature;
    lastNotionPageId = result.pageId;
    
    // Track open incident for resolution
    openIncidents.set(signature, {
      pageId: result.pageId,
      openedAt: incident.timestamp,
      title: incident.title,
      detail: incident.detail,
      homebaseSha: incident.homebaseSha,
      bridgeVersion: incident.bridgeVersion,
    });
    
    // Track for correlation
    allIncidents.push({
      homebaseSha: incident.homebaseSha || 'unknown',
      bridgeVersion: incident.bridgeVersion || 'unknown',
      status: 'Open',
      openedAt: incident.timestamp,
      resolvedAt: null,
      duration: null,
    });
    
    // Persist to JSONL
    appendIncidentLog({
      homebaseSha: incident.homebaseSha || 'unknown',
      bridgeVersion: incident.bridgeVersion || 'unknown',
      status: 'Open',
      openedAt: incident.timestamp,
      title: incident.title,
      isFlapping: isFlapping,
    });
    
    // Invalidate correlation cache
    correlationCache.timestamp = 0;
  }
}

// Path to homebase-logs.jsonl on Victus
const HOMEBASE_LOGS_PATH = process.env.HOMEBASE_LOGS_PATH || 'C:\\AtomArcade\\atomarcade-bridge\\homebase-logs.jsonl';

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

// ════════════════════════════════════════════════════════════════════
// LOXA ROUTING LAYER (v0) ───────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════

// Telemetry route patterns
const TELEMETRY_PATTERNS = [
  'health', 'incident', 'correlation', 'export', 'bridge', 'notion', 'ollama'
];

// Lore route patterns  
const LORE_PATTERNS = [
  'lore', 'memory', 'profile', 'identity', 'kb', 'knowledge', 'curator'
];

// Kraken (execute) route patterns - HIGH RISK
const KRAKEN_PATTERNS = [
  'run', 'execute', 'apply', 'mutate', 'deploy', 'powershell', 'write', 
  'delete', 'create file', 'install', 'remove file', 'shell'
];

// Generate traceId
function generateTraceId() {
  return `trace_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// Route classifier (deterministic, no LLM)
function classifyRequest(body, query) {
  const text = JSON.stringify(body || {}).toLowerCase() + 
             JSON.stringify(query || {}).toLowerCase();
  
  // Check telemetry
  for (const p of TELEMETRY_PATTERNS) {
    if (text.includes(p)) return 'telemetry';
  }
  
  // Check lore  
  for (const p of LORE_PATTERNS) {
    if (text.includes(p)) return 'lore';
  }
  
  // Check kraken (execute) - dangerous
  for (const p of KRAKEN_PATTERNS) {
    if (text.includes(p)) return 'kraken';
  }
  
  return 'unknown';
}

// Route decision with guardrails
function decideRoute(route, body, query) {
  const ALLOWED_ROUTES = ['telemetry', 'lore']; // kraken is DENIED by default
  const isAllowed = ALLOWED_ROUTES.includes(route);
  
  let decision = 'deny';
  let reason = 'default-deny';
  let next = null;
  
  if (route === 'telemetry') {
    decision = 'allow';
    reason = 'telemetry routes are safe';
    next = { endpoint: '/api/bridge/incidents/correlation', method: 'GET' };
  } else if (route === 'lore') {
    decision = 'allow';
    reason = 'lore routes are safe';
    next = { endpoint: '/api/lore/profile', method: 'GET' };
  } else if (route === 'kraken') {
    decision = 'deny';
    reason = 'kraken routes are locked - requires human approval';
  } else if (route === 'unknown') {
    decision = 'needs_human';
    reason = 'unrecognized request - human review required';
  }
  
  return { decision, reason, next };
}

// POST /api/route - Loxa routing entrypoint
app.post('/api/route', (req, res) => {
  const traceId = generateTraceId();
  const { body, query } = req;
  
  // Classify request
  const route = classifyRequest(body, query);
  
  // Decide with guardrails
  const { decision, reason, next } = decideRoute(route, body, query);
  
  // Build response
  const response = {
    traceId,
    route,
    confidence: route === 'unknown' ? 0.0 : 1.0,
    decision,
    reason,
    next,
    timestamp: new Date().toISOString(),
    homeBaseSha: GIT_SHA,
  };
  
  // Emit routing event (for telemetry)
  const eventType = decision === 'allow' ? 'route_allowed' 
               : decision === 'deny' ? 'route_denied' 
               : 'route_needs_human';
               
  console.log(`[loxa] ${eventType}: traceId=${traceId} route=${route} decision=${decision}`);
  
  // Always return decision (no silent fails)
  res.json(response);
});

// ════════════════════════════════════════════════════════════════════════════
// LORE INTEGRATION (v0) ───────────────────────────────────────────────────────
// Read-only knowledge surface
// ════════════════════════════════════════════════════════════════════

const LORE_DIR = process.env.LORE_DIR || path.join(process.cwd(), 'lore');
const PROFILE_PATH = path.join(LORE_DIR, 'profile.json');
const INDEX_PATH = path.join(LORE_DIR, 'index.jsonl');

// Load profile (cached)
let profileCache = null;
function loadProfile() {
  if (profileCache) return profileCache;
  try {
    if (existsSync(PROFILE_PATH)) {
      profileCache = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));
    }
  } catch (e) {
    // ignore
  }
  return profileCache;
}

// Load index (cached)
let indexCache = null;
function loadIndex() {
  if (indexCache) return indexCache;
  try {
    if (existsSync(INDEX_PATH)) {
      const content = readFileSync(INDEX_PATH, 'utf8');
      indexCache = content.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    }
  } catch (e) {
    // ignore
  }
  return indexCache || [];
}

// GET /api/lore/profile - returns operator profile
app.get('/api/lore/profile', (req, res) => {
  const profile = loadProfile();
  const traceId = req.headers['x-trace-id'] || 'no-trace';
  
  if (!profile) {
    console.log(`[lore] profile_not_found: traceId=${traceId}`);
    return res.json({ ok: false, detail: 'profile not configured' });
  }
  
  console.log(`[lore] profile_read: traceId=${traceId} name=${profile.name}`);
  res.json({ ok: true, profile, traceId });
});

// GET /api/lore/search?q=... - search lore index
app.get('/api/lore/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const index = loadIndex();
  const traceId = req.headers['x-trace-id'] || 'no-trace';
  
  const results = q 
    ? index.filter(e => 
        e.title.toLowerCase().includes(q) || 
        e.tags.some(t => t.includes(q)) ||
        e.summary.toLowerCase().includes(q)
      )
    : index.slice(0, 10);
  
  console.log(`[lore] search: traceId=${traceId} q="${q}" results=${results.length}`);
  res.json({ ok: true, query: q, count: results.length, entries: results, traceId });
});

// GET /api/lore/entry/:id - get single entry
app.get('/api/lore/entry/:id', (req, res) => {
  const id = req.params.id;
  const index = loadIndex();
  const traceId = req.headers['x-trace-id'] || 'no-trace';
  
  const entry = index.find(e => e.id === id);
  
  if (!entry) {
    console.log(`[lore] entry_not_found: traceId=${traceId} id=${id}`);
    return res.json({ ok: false, detail: 'entry not found' });
  }
  
  console.log(`[lore] entry_read: traceId=${traceId} id=${id}`);
  res.json({ ok: true, entry, traceId });
});

// KRAKEN EXECUTION ENGINE (v0)
// Default-deny, require operator confirm, rate limited

const KRAKEN_RATE_LIMIT = 10;
const KRAKEN_RATE_WINDOW = 60000;
const KRAKEN_TIMEOUT_MS = 5000;
let rateLimitBuckets = new Map();

const { getActions, getAction, hashParams } = require('./lib/kraken/registry');
const { scanForSecrets, validateParams } = require('./lib/kraken/validate');

function checkRateLimit(traceId) {
  const now = Date.now();
  const key = traceId.slice(-8);
  const last = rateLimitBuckets.get(key) || 0;
  if (now - last < KRAKEN_RATE_WINDOW) return false;
  rateLimitBuckets.set(key, now);
  for (const [k, v] of rateLimitBuckets) {
    if (now - v > KRAKEN_RATE_WINDOW) rateLimitBuckets.delete(k);
  }
  return true;
}

app.get('/api/kraken/actions', (req, res) => {
  res.json({ ok: true, actions: getActions(), count: getActions().length });
});

app.post('/api/kraken/execute', async (req, res) => {
  const startTime = Date.now();
  const traceId = req.headers['x-trace-id'] || `trace_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const confirm = req.headers['x-operator-confirm'];
  
  if (confirm !== 'yes') {
    console.log(`[kraken] denied: traceId=${traceId} reason=operator_confirm_missing`);
    return res.status(403).json({ ok: false, traceId, decision: 'denied', reason: 'operator_confirm_missing' });
  }
  
  if (!checkRateLimit(traceId)) {
    console.log(`[kraken] denied: traceId=${traceId} reason=rate_limited`);
    return res.status(429).json({ ok: false, traceId, decision: 'denied', reason: 'rate_limited' });
  }
  
  const { action, params = {} } = req.body;
  const actionDef = getAction(action);
  
  if (!actionDef) {
    console.log(`[kraken] denied: traceId=${traceId} action=${action} reason=action_not_allowlisted`);
    return res.status(403).json({ ok: false, traceId, action, decision: 'denied', reason: 'action_not_allowlisted' });
  }
  
  if (scanForSecrets(params)) {
    console.log(`[kraken] denied: traceId=${traceId} action=${action} reason=secret_in_params`);
    return res.status(403).json({ ok: false, traceId, action, decision: 'denied', reason: 'secret_in_params' });
  }
  
  const errors = validateParams(params, actionDef.paramSchema);
  if (errors.length > 0) {
    console.log(`[kraken] denied: traceId=${traceId} action=${action} reason=invalid_params`);
    return res.status(400).json({ ok: false, traceId, action, decision: 'denied', reason: 'invalid_params', errors });
  }
  
  console.log(`[kraken_pre] traceId=${traceId} action=${action} paramsHash=${hashParams(params)}`);
  
  let result;
  try {
    result = await Promise.race([
      actionDef.handler(params, { traceId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), KRAKEN_TIMEOUT_MS))
    ]);
  } catch (err) {
    console.log(`[kraken] error: traceId=${traceId} action=${action} error=${err.message}`);
    return res.status(500).json({ ok: false, traceId, action, decision: 'denied', reason: 'action_timeout' });
  }
  
  const durationMs = Date.now() - startTime;
  console.log(`[kraken_post] traceId=${traceId} action=${action} ok=true durationMs=${durationMs}`);
  
  res.json({ ok: true, traceId, action, decision: 'executed', result, durationMs });
});

// KRAKEN_END

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

// Proxy endpoint: fetch bridge health from AtomArcade Bridge
// Uses BRIDGE_BASE_URL (defaults to http://localhost:8080)
app.get('/api/bridge/health', async (_req, res) => {
  const bridgeUrl = process.env.BRIDGE_BASE_URL;
  
  // Gracefully handle missing BRIDGE_BASE_URL
  if (!bridgeUrl) {
    return res.json({
      ok: false,
      detail: 'BRIDGE_BASE_URL not set',
      timestamp: new Date().toISOString(),
    });
  }
  
  try {
    // Short timeout fetch (3 seconds)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    
    const response = await fetch(`${bridgeUrl}/api/health`, {
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    let data;
    if (response.ok) {
      data = await response.json();
    } else {
      data = {
        ok: false,
        detail: `Bridge HTTP ${response.status}`,
        timestamp: new Date().toISOString(),
      };
    }
    
    // Store in history and get telemetry
    addHealthSnapshot(data);
    const flapping = getFlappingStatus();
    
    // Handle incident detection (non-blocking)
    handleHealthTransition(data, flapping).catch(err => 
      console.error('[incident] Handler error:', err.message)
    );
    
    // Attach telemetry metadata to response
    const telemetry = {
      historyLength: healthHistory.length,
      isFlapping: flapping === 'flapping',
      firstFailureTime: flapping?.firstFailureAt || null,
      lastSuccessTime: flapping?.lastSuccessAt || null,
    };
    
    return res.json({
      ...data,
      telemetry,
    });
  } catch (error) {
    // Catch network errors, timeouts, etc.
    const errorData = {
      ok: false,
      detail: error instanceof Error ? error.message : 'Bridge unreachable',
      timestamp: new Date().toISOString(),
    };
    
    // Still record the failure
    addHealthSnapshot(errorData);
    const flapping = getFlappingStatus();
    
    // Handle incident detection (non-blocking)
    handleHealthTransition(errorData, flapping).catch(err => 
      console.error('[incident] Handler error:', err.message)
    );
    
    return res.json({
      ...errorData,
      telemetry: {
        historyLength: healthHistory.length,
        isFlapping: flapping === 'flapping',
        firstFailureTime: flapping?.firstFailureAt || null,
        lastSuccessTime: flapping?.lastSuccessAt || null,
      },
    });
  }
});

// Endpoint to get health history
app.get('/api/bridge/health/history', (_req, res) => {
  res.json({
    history: healthHistory,
    flapping: getFlappingStatus(),
  });
});

// Incident log path for persistence
const INCIDENT_LOG_PATH = process.env.INCIDENT_LOG_PATH || 'C:\\AtomArcade\\incident-log.jsonl';

// Ensure incident log directory exists
function ensureIncidentLogDir() {
  try {
    const dir = dirname(INCIDENT_LOG_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch {}
}

// Append to incident log (JSONL format)
function appendIncidentLog(incident) {
  try {
    ensureIncidentLogDir();
    const line = JSON.stringify({
      ...incident,
      timestamp: incident.timestamp || new Date().toISOString(),
    }) + '\n';
    appendFileSync(INCIDENT_LOG_PATH, line);
  } catch (e) {
    console.error('[incident] Failed to write log:', e.message);
  }
}

// Read incidents from JSONL
function readIncidentLog() {
  const incidents = [];
  try {
    if (!existsSync(INCIDENT_LOG_PATH)) {
      return incidents;
    }
    const content = readFileSync(INCIDENT_LOG_PATH, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    for (const line of lines) {
      try {
        const inc = JSON.parse(line);
        // Parse durationMs if present
        if (inc.resolvedAt && inc.openedAt) {
          inc.durationMs = new Date(inc.resolvedAt).getTime() - new Date(inc.openedAt).getTime();
        }
        incidents.push(inc);
      } catch {
        // Skip malformed lines
      }
    }
  } catch (e) {
    console.error('[incident] Failed to read log:', e.message);
  }
  return incidents;
}

// Cache for correlation results
let correlationCache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 30000; // 30 seconds

// Build correlation from incidents with window filter
function buildCorrelation(incidents, window) {
  const now = Date.now();
  const windowMs = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    'all': Infinity,
  }[window] || (24 * 60 * 60 * 1000);
  
  const groups = new Map();
  
  for (const inc of incidents) {
    const incTime = new Date(inc.openedAt || inc.timestamp).getTime();
    if (now - incTime > windowMs) continue;
    
    const key = `${inc.homebaseSha || inc.homeBaseSha || 'unknown'}|${inc.bridgeVersion || inc.bridgeSha || 'unknown'}`;
    if (!groups.has(key)) {
      groups.set(key, {
        homeBaseSha: inc.homebaseSha || inc.homeBaseSha || 'unknown',
        bridgeSha: inc.bridgeVersion || inc.bridgeSha || 'unknown',
        count: 0,
        openCount: 0,
        flappingCount: 0,
        lastSeen: null,
        durations: [],
      });
    }
    const g = groups.get(key);
    g.count++;
    if (inc.status === 'Open') g.openCount++;
    if (inc.isFlapping) g.flappingCount++;
    if (inc.status === 'Resolved' && inc.resolvedAt) {
      g.durations.push({ openedAt: inc.openedAt, resolvedAt: inc.resolvedAt });
    }
    const incTs = inc.openedAt || inc.timestamp;
    if (!g.lastSeen || incTs > g.lastSeen) {
      g.lastSeen = incTs;
    }
  }
  
  // Calculate avg duration
  return Array.from(groups.values()).map(g => {
    let avgDuration = 'N/A';
    let avgDurationMs = null;
    if (g.durations.length > 0) {
      let totalMs = 0;
      for (const d of g.durations) {
        try {
          totalMs += new Date(d.resolvedAt).getTime() - new Date(d.openedAt).getTime();
        } catch {}
      }
      avgDurationMs = Math.round(totalMs / g.durations.length);
      avgDuration = avgDurationMs < 60000 
        ? '<1 min' 
        : `${Math.round(avgDurationMs / 60000)} min`;
    }
    return {
      homeBaseSha: g.homeBaseSha,
      bridgeSha: g.bridgeSha,
      count: g.count,
      openCount: g.openCount,
      flappingCount: g.flappingCount,
      lastSeen: g.lastSeen,
      avgDuration,
      avgDurationMs, // numeric for sorting if needed
    };
  }).sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
}

// Deploy Correlation: group incidents by (HomeBaseSHA, BridgeSHA) - persistent
app.get('/api/bridge/incidents/correlation', (req, res) => {
  const window = req.query.window || '24h';
  const now = Date.now();
  
  // Check cache
  if (correlationCache.data && now - correlationCache.timestamp < CACHE_TTL_MS) {
    const cached = correlationCache.data;
    // Filter by window if needed (simple approach: rebuild)
    const rows = buildCorrelation(cached.incidents, window);
    return res.json({
      rows,
      window,
      generatedAt: cached.generatedAt,
      source: 'cache',
    });
  }
  
  // Read from JSONL + in-memory
  const diskIncidents = readIncidentLog();
  const memIncidents = allIncidents.map(inc => ({
    homebaseSha: inc.homebaseSha,
    bridgeVersion: inc.bridgeVersion,
    status: inc.status,
    openedAt: inc.openedAt,
    resolvedAt: inc.resolvedAt,
    isFlapping: false, // not tracked in memory
    timestamp: inc.openedAt,
  }));
  
  // Merge (disk first, then memory for newer entries)
  const all = [...diskIncidents];
  for (const inc of memIncidents) {
    const exists = all.some(a => a.openedAt === inc.openedAt && a.homebaseSha === inc.homebaseSha);
    if (!exists) all.push(inc);
  }
  
  // Build result
  const rows = buildCorrelation(all, window);
  const generatedAt = new Date().toISOString();
  
  // Update cache
  correlationCache = { data: { incidents: all, generatedAt }, timestamp: now };
  
  res.json({
    rows,
    window,
    generatedAt,
    source: 'disk+memory',
  });
});

// Export correlation as CSV
app.get('/api/bridge/incidents/correlation/export', (req, res) => {
  const window = req.query.window || '24h';
  
  // Read from JSONL + in-memory (bypass cache for fresh export)
  const diskIncidents = readIncidentLog();
  const memIncidents = allIncidents.map(inc => ({
    homebaseSha: inc.homebaseSha,
    bridgeVersion: inc.bridgeVersion,
    status: inc.status,
    openedAt: inc.openedAt,
    resolvedAt: inc.resolvedAt,
    isFlapping: false,
    timestamp: inc.openedAt,
  }));
  
  const all = [...diskIncidents];
  for (const inc of memIncidents) {
    const exists = all.some(a => a.openedAt === inc.openedAt && a.homebaseSha === inc.homebaseSha);
    if (!exists) all.push(inc);
  }
  
  const rows = buildCorrelation(all, window);
  
  // Build CSV
  const header = 'homeBaseSha,bridgeSha,count,openCount,flappingCount,lastSeen,avgDuration,avgDurationMs';
  const lines = [header];
  for (const row of rows) {
    lines.push([
      row.homeBaseSha,
      row.bridgeSha,
      row.count,
      row.openCount,
      row.flappingCount || 0,
      row.lastSeen || '',
      row.avgDuration || 'N/A',
      row.avgDurationMs || '',
    ].join(','));
  }
  
  const csv = lines.join('\n');
  const generatedAt = new Date().toISOString();
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="correlation-${window}-${generatedAt.slice(0,10)}.csv"`);
  res.send(csv);
});

// Read homebase-logs.jsonl from Victus and return recent entries
app.get('/api/logs', (_req, res) => {
  try {
    if (!existsSync(HOMEBASE_LOGS_PATH)) {
      return res.json({ entries: [], error: 'Log file not found', path: HOMEBASE_LOGS_PATH });
    }
    
    const content = readFileSync(HOMEBASE_LOGS_PATH, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    
    // Parse JSONL and get last 50 entries
    const entries = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        entries.push(entry);
      } catch {
        // Skip malformed lines
      }
    }
    
    const recent = entries.slice(-50).reverse(); // Last 50, newest first
    
    res.json({
      entries: recent,
      total: entries.length,
      path: HOMEBASE_LOGS_PATH,
    });
  } catch (err) {
    res.status(500).json({
      error: 'Failed to read logs',
      detail: err?.message || String(err),
      path: HOMEBASE_LOGS_PATH,
    });
  }
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

// Run a HomeBase script
app.post('/api/run/:script', async (req, res) => {
  const script = req.params.script;
  
  // Alpha loop (special case)
  if (script === 'alpha-loop') {
    try {
      const result = await runAlphaLoop();
      return res.json({
        script,
        status: result.status,
        loopId: result.loopId,
        timestamp: result.timestamp,
        message: result.status === 'success' 
          ? `Loop completed: Observer → Evaluator → Proposer`
          : result.error,
      });
    } catch (err) {
      return res.status(500).json({
        script,
        status: 'error',
        error: err.message || String(err),
      });
    }
  }

  // Individual scripts (placeholder)
  const validScripts = ['observer', 'evaluator', 'proposer', 'curator', 'applier', 'reflector'];
  
  if (!validScripts.includes(script)) {
    return res.status(400).json({ error: 'unknown script', script });
  }
  
  try {
    res.json({
      script,
      status: 'running',
      message: `${script} script initiated`,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      error: 'script execution failed',
      detail: err?.message || String(err),
    });
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
  console.log(`[homebase] reading logs from: ${HOMEBASE_LOGS_PATH}`);
  console.log(`[homebase] Gemini configured: ${Boolean(process.env.GEMINI_API_KEY)}`);
});
