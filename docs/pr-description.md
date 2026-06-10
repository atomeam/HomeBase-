# P0 Build Homebase v1 (new repo app skeleton)

## What changed

- Added a TypeScript + Express Homebase app with read-only routes:
  - `GET /` dashboard
  - `GET /health` status
- Added read-only Bridge API client module for:
  - Tasks feed (`/tasks`)
  - Audit events feed (`/ops/deploy-event`)
- Added Notion canonical links sourced from environment config:
  - Workspace Index
  - Roster
  - Role cards
- Added feature flags for future Notion pull/sync behavior:
  - `NOTION_PULL_ENABLED`
  - `NOTION_SYNC_ENABLED`
- Added read-only guard middleware that rejects non-GET/HEAD/OPTIONS methods.
- Added CI workflows:
  - `ci.yml` for lint/test/build
  - `deploy.yml` for operator-gated packaging with no direct deploy authority
- Added docs:
  - `README.md`
  - `CONTRIBUTING.md`
  - `.env.example` for config and secret handling

## Constraints compliance

- No production schema changes introduced.
- No write endpoints implemented in v1.
- No hardcoded IDs or secret values in source.
- Notion behaviors that can mutate/sync are feature-flagged.

## Validation evidence (local)

### 1) Typecheck/lint

Command:

```bash
npm run lint
```

Output:

```text
> homebase@0.1.0 lint
> tsc --noEmit -p tsconfig.json
```

### 2) Tests

Command:

```bash
npm test
```

Output:

```text
RUN  v2.1.9 C:/Users/adamm/HomeBase
✓ tests/bridge-client.test.ts (2 tests)
✓ tests/app.test.ts (3 tests)
Test Files  2 passed (2)
Tests       5 passed (5)
```

### 3) Build

Command:

```bash
npm run build
```

Output:

```text
> homebase@0.1.0 build
> tsc -p tsconfig.build.json
```

### 4) Runtime smoke check

Command:

```bash
node dist/server.js
# then request /health and /
```

Observed response checks:

```text
health_status 200
dashboard_status 200
has_tasks_section true
has_events_section true
has_workspace_link true
```

## Deployment note

The deploy workflow intentionally does not include direct deployment credentials or an auto-deploy step. It creates and uploads an artifact, then requires operator handoff.
