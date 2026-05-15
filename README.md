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
