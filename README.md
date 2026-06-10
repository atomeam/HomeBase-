# Homebase v1

Homebase is the primary cockpit for **docs + status + tasks + ops links**, delivered as a minimal read-only web app so production lanes stay stable while workflows are migrated.

## v1 Scope

- Dashboard route: `/`
- Health route: `/health`
- Read-only Bridge client for:
  - Tasks Hub status (`/tasks` by default)
  - Recent audit events (`/ops/deploy-event` by default)
- Canonical Notion links:
  - Workspace Index
  - Roster
  - Role cards
- CI pipeline for build/test and a gated deploy workflow with **no direct deploy authority**

## Guardrails

- No production schema changes are implemented here.
- No write endpoints are exposed in v1.
- Any future write endpoints must add strict request validation and operator approval checks.
- Notion pull/sync behavior is controlled by feature flags.

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`.

## Routes

- `GET /` - Homebase dashboard (server-rendered HTML)
- `GET /health` - Service health/status JSON

## Configuration

Copy `.env.example` to `.env` and set the following values:

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | no | App port (default: `3000`) |
| `BRIDGE_BASE_URL` | yes | Base URL for Bridge read-only API |
| `BRIDGE_API_TOKEN` | sometimes | Bearer token for Bridge if auth is enabled |
| `BRIDGE_TASKS_PATH` | no | Tasks endpoint path (default: `/tasks`) |
| `BRIDGE_AUDIT_EVENTS_PATH` | no | Audit endpoint path (default: `/ops/deploy-event`) |
| `NOTION_WORKSPACE_INDEX_URL` | yes | Canonical Notion Workspace Index URL |
| `NOTION_ROSTER_URL` | yes | Canonical Notion Roster URL |
| `NOTION_ROLE_CARDS_URL` | yes | Canonical Notion Role cards URL |
| `NOTION_PULL_ENABLED` | no | Feature flag for pull behavior (`true`/`false`) |
| `NOTION_SYNC_ENABLED` | no | Feature flag for sync behavior (`true`/`false`) |

## Secrets

- Do not hardcode IDs, API tokens, or page URLs in source.
- Store secret values in CI secret stores and runtime environment configuration.

## Verification

```bash
npm run lint
npm test
npm run build
```

## CI/CD

- `.github/workflows/ci.yml`: lint + test + build on PR/push.
- `.github/workflows/deploy.yml`: prepares deploy artifact and enforces operator-gated handoff. No direct cloud credentials or auto-deploy step are configured.
