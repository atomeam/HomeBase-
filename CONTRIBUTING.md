# Contributing to Homebase

## Branch and PR Flow

1. Create a feature branch from `main`.
2. Implement small, reviewable changes.
3. Include local command evidence in the PR description.
4. Open a PR and wait for CI and operator review.

## Required Checks Before PR

```bash
npm run lint
npm test
npm run build
```

## Engineering Constraints

- Preserve read-only behavior in v1 routes.
- Avoid production schema changes unless a migration is prepared and explicitly approved by operators.
- For any future write endpoint, add strict payload validation and explicit authorization checks.
- Keep Notion pull/sync logic behind feature flags.

## Environment Hygiene

- Never hardcode secret tokens or private page IDs.
- Use `.env` locally and CI secret stores in automation.
