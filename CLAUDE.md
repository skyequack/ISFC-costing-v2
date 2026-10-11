# ISFC — project rules
**Mode (D-64): the sample app is fully migrated. We now integrate new features as Omer describes them, not copy the sample.** Process: `docs/FEATURES.md`. For every new feature run `/feature-team` (architect, backend, database, optimisation, frontend, security, QA, domain analyst in `.claude/agents/`) and get Omer's approval of the plan before coding.

**Start here:** `README.md` (reading order) → `docs/PROGRESS.md` (state/next steps) → `docs/FEATURES.md` → `DECISIONS.md`. Never rely on prior chat/session context; if something is not in these files, it is not decided — ask the user and record it.

- `legacy/**` and `golden/**` are read-only **regression baselines** (existing behavior must not change unless a feature says so). Regenerate golden only via `tools/*.js`, never by hand. `db/seed-data/**` is generated; don't hand-edit. Database = Neon via `pg` + plain SQL (no ORM, D-50); schema changes = a new numbered file in `db/migrations/`, never an edit to an applied one.
- Never merge/dedupe/rename ingredients; keep flags and null prices verbatim (null ≠ 0).
- Costing = pure TS in `src/domain/costing`, ported line-for-line from `docs/legacy/02-costing-engine.md` / `legacy/app.html` 1362–1480; JS doubles / Postgres `double precision`, never Decimal; no new rounding (round only at display/export). Requisition math is a separate module.
- UI: existing screens keep the legacy CSS, class names and wording unless a feature changes them. New features reuse legacy classes first and list their new strings for Omer's approval. No UI kits/Tailwind/next-font or other new dependency without a `DECISIONS.md` row (docs/UI_PORT.md, docs/FEATURES.md).
- Clerk is the only auth and the source of role; every route handler uses `withAuth`; client `can()` is cosmetic. Brand scoping goes through repositories requiring `visibleBrandIds(user)`; out-of-scope ids → 404.
- Do not recreate global `S`; DB is source of truth; no localStorage persistence; no Python; no Clerk Organizations.
- Every new feature, and any change to existing behavior, needs a `DECISIONS.md` row first (new features: D-65 onward) plus a row in the `docs/FEATURES.md` log. `DECISIONS.md` overrides `SOURCE_OF_TRUTH.md`/`MEGA_PROMPT.md`.
- Update `docs/PROGRESS.md` (and affected docs) in the same change as the code.
- Before claiming done: typecheck, lint, tests pass (docs/TESTING.md gates) and report anything skipped. Use fresh-context `/code-review` and `/security-review` at each phase gate.
- Secrets only in `.env` (gitignored); never print or commit them. The user pastes keys into `.env`.
