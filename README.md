<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# HomeBase

Operator surface for **Alpha** — the self-improving loop:

    observe → evaluate → propose → validate → apply → reflect

Every step is wrapped by Curator default-deny. See [ALPHA.md](./ALPHA.md) for the contract and `src/alpha/` for the runtime.

View app in AI Studio: https://ai.studio/apps/b5aaaeef-c202-4714-bf1a-9659a0516786

## Run locally

Prereqs: Node.js 22+.

```
npm install
cp .env.example .env.local      # then set GEMINI_API_KEY in .env.local
npm run server:dev              # terminal 1 — Express on :8080
npm run dev                     # terminal 2 — Vite client on :3000
```

The Vite dev server proxies `/api/*` to `http://localhost:8080`, so the client never sees `GEMINI_API_KEY`.

## Endpoints

- `GET  /api/health` — service status, version, git sha, building info, bridge + Gemini config flags.
- `POST /api/prompt/:name` — dispatches an Alpha prompt to Gemini server-side. Names: `observer`, `evaluator`, `proposer`, `curator`, `applier`, `reflector`, `repeatCheck`, `councilSecondOpinion`. Body: `{ "input": "…" }`.

## Tests

```
npm test           # one-shot
npm run test:watch # watch mode
```

Covers all Curator denial codes and all 9 Applier hardening rules.

## Bridge Health Monitoring

HomeBase polls the AtomArcade Bridge every 15 seconds to check:

- **env** — required environment variables loaded
- **notion** — Notion API connectivity (`/users/me`)
- **ollama** — local Ollama runtime (`/api/tags`)
- **gemini** — Gemini API key valid (if configured)

### Health Telemetry

The `/api/bridge/health` endpoint returns:

```json
{
  "ok": true,
  "checks": { "env": { "ok": true, ... }, ... },
  "telemetry": {
    "historyLength": 5,
    "isFlapping": false,
    "firstFailureTime": null,
    "lastSuccessTime": "2026-05-18T12:00:00Z"
  }
}
```

- `isFlapping`: true if 3+ failures in last 10 checks.
- `firstFailureTime`: timestamp of first consecutive failure.

### Alert Banner

A red alert banner appears when:
- Overall status flips from `ok: true` to `ok: false`
- Flapping is detected (3+ failures in 10 checks)

### History Persistence

Health snapshots are stored in-memory (ring buffer of 50) and optionally persisted to JSONL:

```bash
HOMEBASE_HEALTH_HISTORY_PATH=C:\AtomArcade\health-history.jsonl
```

## Incident Logging (Optional)

When bridge health fails, HomeBase can write incidents to Notion.

### Requirements

1. Enable the feature:
```bash
NOTION_INCIDENT_LOG_ENABLED=true
```

2. Configure Notion:
```bash
NOTION_API_KEY=secret_...
ATOMARCADE_NOTION_LOG_DB_ID=your-log-db-id
```

### How It Works

- Triggers on: `ok` flips true→false, OR flapping starts (false→true)
- Rate limited: 1 incident per unique failure signature per 30 minutes
- No secrets written: API keys never appear in Notion

### Notion Schema

If using the Logs DB, ensure it has these properties:
- **Kind**: Select (e.g., "Incident", "Log")
- **Timestamp**: Title or Rich Text
- **Status**: Select (e.g., "Open", "Resolved")
- **Detail**: Rich Text
- **Source**: Rich Text (e.g., "HomeBase Telemetry")

### Automated Resolution

When the system recovers (health transitions from `ok: false` → `ok: true`), the most recent incident is automatically resolved:

1. System detects: `ok` flips false → true
2. Looks up open incident by signature (same failed checks)
3. Updates Status: "Open" → "Resolved"
4. Appends: `Resolved at <timestamp> (Duration: X min HomeBaseSHA=...)`
5. Clears tracking so next failure creates a fresh incident

This ensures you never have stale "Open" incidents after temporary blips.

### Version Correlation

Every incident now includes version information for deployment correlation:

**On Open:**
- `HomeBaseSHA`: Git SHA of HomeBase (from `GIT_SHA` env or `.git/HEAD`)
- `BridgeVersion`: Version reported by Bridge (`bridge.version` or `bridge.gitSha`)
- `BridgeURL`: The bridge endpoint being monitored

Encoded in Detail: `HomeBaseSHA=<...> BridgeVersion=<...> BridgeURL=<...> | <failure detail>`

**On Resolve:**
- Appends: `Resolved at <timestamp> (Duration: X min HomeBaseSHA=<...>)`

This enables correlating outages to specific deploys.

### Deploy Correlation View

Group incidents by version pair to identify regressions. Data is persisted to JSONL and survives restarts.

**Endpoint:**

```bash
GET /api/bridge/incidents/correlation?window=24h|7d|all
```

**Query Params:**

| Param | Default | Description |
|-------|---------|-------------|
| `window` | `24h` | Time window: `24h`, `7d`, or `all` |

**Response:**

```json
{
  "rows": [
    {
      "homeBaseSha": "abc1234",
      "bridgeSha": "def5678",
      "count": 5,
      "openCount": 1,
      "flappingCount": 0,
      "lastSeen": "2026-05-18T12:34:56Z",
      "avgDuration": "3 min",
      "avgDurationMs": 180000
    }
  ],
  "window": "24h",
  "generatedAt": "2026-05-18T12:34:56Z",
  "source": "disk+memory"
}
```

**Features:**
- Persists to `C:\AtomArcade\incident-log.jsonl` (configurable via `INCIDENT_LOG_PATH`)
- In-memory cache for 30s (invalidated on new incident)
- Numeric `avgDurationMs` available for programmatic sorting
- 7d shows superset of 24h

**Export:**

```bash
GET /api/bridge/incidents/correlation/export?window=24h
```

Returns CSV file for postmortems.

---

## Loxa Routing Layer (v0)

Single routing entrypoint with classification and guardrails.

### POST /api/route

**Request:**
```json
{
  "request": "show correlation export"
}
```

**Response:**
```json
{
  "traceId": "trace_1234567_abc123",
  "route": "telemetry",
  "confidence": 1.0,
  "decision": "allow",
  "reason": "telemetry routes are safe",
  "next": { "endpoint": "/api/bridge/incidents/correlation", "method": "GET" },
  "timestamp": "2026-05-18T12:00:00.000Z",
  "homeBaseSha": "abc1234"
}
```

**Routing Decisions:**

| Route | Decision | Notes |
|-------|----------|-------|
| `telemetry` | allow | Health, incidents, correlation, export |
| `lore` | allow | Memory, profile, curator |
| `kraken` | deny | Run, execute, deploy - locked by default |
| `unknown` | needs_human | Unrecognized - requires review |

**Test Harness:**
```bash
node loxa-test.js
```

---

## Lore Integration (v0)

Read-only knowledge surface behind Loxa router.

### Files

- `lore/profile.json` — Operator profile
- `lore/index.jsonl` — Searchable lore entries

### GET /api/lore/profile

Returns the operator profile:

```json
{
  "ok": true,
  "profile": { "name": "Loxa", ... },
  "traceId": "trace_..."
}
```

### GET /api/lore/search?q=...

Search lore entries:

```bash
GET /api/lore/search?q=telemetry
```

### GET /api/lore/entry/:id

Get single entry:

```bash
GET /api/lore/entry/lore-001
```

---

## Kraken Execution Engine (v0)

Default-deny, require operator confirm, rate limited.

### GET /api/kraken/actions

Returns allowlist with schemas.

### POST /api/kraken/execute

**Headers required:**
- `X-Operator-Confirm: yes` (else 403)
- `X-Trace-Id: <uuid>` (optional)

**Body:**
```json
{
  "action": "echo",
  "params": { "message": "hello" }
}
```

**Response:**
```json
{
  "ok": true,
  "traceId": "trace_...",
  "action": "echo",
  "decision": "executed",
  "result": { "echoed": "hello", "at": "..." },
  "durationMs": 5
}
```

### Actions (v0)

| Action | Description | Params |
|--------|-------------|--------|
| `echo` | Diagnostic echo | `message: string (1-200)` |
| `incident.note` | Append note to log | `note: string (1-500), severity: info\|warn` |

### Guardrails

- Default-deny
- Operator confirm required
- Rate limit: 10/min
- Secret scanner blocks tokens
- 5s timeout per action

### Test Harness
```bash
node kraken-test.js
```
