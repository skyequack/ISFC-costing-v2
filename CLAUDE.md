# ISFC migration — project rules
**Start here:** `README.md` (reading order) → `docs/PROGRESS.md` (state/next steps) → `DECISIONS.md`. Never rely on prior chat/session context; if something is not in these files, it is not decided — ask the user and record it.

- `legacy/**` and `golden/**` are read-only oracles. Regenerate golden only via `tools/*.js`, never by hand. `db/seed-data/**` is generated; don't hand-edit. Database = Neon via `pg` + plain SQL (no ORM, D-50); schema changes = a new numbered file in `db/migrations/`, never an edit to an applied one.
- Never merge/dedupe/rename ingredients; keep flags and null prices verbatim (null ≠ 0).
- Costing = pure TS in `src/domain/costing`, ported line-for-line from `docs/legacy/02-costing-engine.md` / `legacy/app.html` 1362–1480; JS doubles / Postgres `double precision`, never Decimal; no new rounding (round only at display/export). Requisition math is a separate module.
- UI is not redesigned: legacy CSS verbatim, same class names/terminology, no UI kits/Tailwind/next-font, no responsive additions (docs/UI_PORT.md). Wording: no changes except the Backup subtitle (D-41, docs/UI_PORT.md §7).
- Clerk is the only auth and the source of role; every route handler uses `withAuth`; client `can()` is cosmetic. Brand scoping goes through repositories requiring `visibleBrandIds(user)`; out-of-scope ids → 404.
- Do not recreate global `S`; DB is source of truth; no localStorage persistence; no Python; no Clerk Organizations.
- Any divergence from legacy behavior needs a `DECISIONS.md` row first. `DECISIONS.md` overrides `SOURCE_OF_TRUTH.md`/`MEGA_PROMPT.md`.
- Update `docs/PROGRESS.md` (and affected docs) in the same change as the code.
- Before claiming done: typecheck, lint, tests pass (docs/TESTING.md gates) and report anything skipped. Use fresh-context `/code-review` and `/security-review` at each phase gate.
- Secrets only in `.env` (gitignored); never print or commit them. The user pastes keys into `.env`.
