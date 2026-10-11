# Phases 3–6: full app build, speed work, loading states

Takes `main` from the Phase 0–2 foundation (costing engine, seed, shell) to a complete, working application. Phase 7 (Vercel deploy, production migration/seed, Clerk role claim) is **not** part of this PR (D-57).

## What's in it
- **Phases 3–4:** services, API routes (all behind `withAuth`), brand scoping, optimistic concurrency, lock gate, audit, users (Clerk), authorisation matrix (243 cases).
- **Phase 5:** every screen ported with the legacy CSS verbatim — Brand Workspaces, Dashboard, Recipe Cards, editor, locked view, print, Ingredient Library, Unit Conversions, Yield Reference, Cost Settings, Data Health, Activity Log, Users & Access, Backup & Export, Production, Preparation, Menu Plans.
- **Phase 6:** own XLSX/CSV reader and writer, price-list and recipe import (hash-checked dry-run → commit), exports, JSON backup and chunked restore (migration `0002_restore_staging.sql`).
- **Speed work** (`docs/PERF_PLAN.md`): a name-only save went from 17 SQL statements to 6 (about 2.5–3.4 s → 0.9 s in dev over Neon), card read 10 → 4. Costing now reads only the card's cost closure; equivalence is tested for all 321 seed cards.
- **Editor:** queued saves merge into one request; picked ingredients show name/price at once; a crash when adding a line before the save returned is fixed.
- **Loading states (D-59):** route skeletons and a top progress bar.
- **Wording (D-58):** stale "manager PIN" / "stored in this file" text replaced.

## Verification
- typecheck, lint, Prettier, 514 offline tests, domain coverage 100% lines/functions and 96.5% branches, `next build`.
- Neon `dev` DB suite: 94 tests (services, routes, planning, imports, exports, backup, save path, cost-closure, seed incl. all 321 golden costs).
- Full click-through of every screen as General Manager, with hand-checked cost figures (notes in `docs/PROGRESS.md`).

## Not verified / needs a human
- A restore **commit** (only the dry-run was exercised) — run it on a throw-away Neon branch.
- Non-GM roles in a real browser (covered by the authorisation matrix only), real printing, user invitations.
- Pixel diffs / Playwright baselines against the legacy file.
- `/security-review` — to be run on this PR.

## Decisions awaiting approval
- D-54 / D-56 (restore semantics, strict recipe import, trimmed Backup screen, list ordering) are still marked 🟡 in `DECISIONS.md`.

## Known gaps
- No rate limiting on import/export/photo/restore routes (needs Upstash or Vercel Firewall).
- Spreadsheets are parsed on the main thread (worker planned).
- The Clerk session token has no `role` claim yet, so every request still calls Clerk for the role (RUNBOOK §3); the single-query user+scope lookup only takes effect once it is set.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
