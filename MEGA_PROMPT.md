# ISFC — Migration agent instructions (condensed)

The original instructions for how the agent was to migrate `legacy/app.html` (the "how"; `SOURCE_OF_TRUTH.md` is the "what"). The migration is complete and new work follows `docs/FEATURES.md`; this file keeps only the working rules that still apply. The full original (three-day plan, phase order, acceptance checklist) is in git history (`git show d9f05e3:MEGA_PROMPT.md`). **`DECISIONS.md` overrides this file** (for example, D-25 removed the deadline and D-50 replaced Prisma with `pg` + plain SQL).

## Working rules that still apply
- **Inspect before changing:** read the legacy behavior (`docs/legacy/*`, `DISCOVERY_FINDINGS.md`, `legacy/app.html`) before changing anything it defines. Preserve the behavior, preserve the UI, replace only the architecture.
- **Costing stays pure:** `src/domain/costing` has no React, browser, Next.js, Clerk or database imports, and is proven against `golden/costs.json`. No new formulas and no new rounding.
- **No invented business rules:** an addition needs a `DECISIONS.md` row and Omer's approval first.
- **Data migration and imports:** deterministic, they report errors, never silently discard or repair records, and never merge ingredients.
- **APIs:** endpoints model application operations (no generic CRUD per table). Route handlers stay thin: `withAuth` → validation → service → transaction → audit. Business logic lives in services and the domain.
- **Server vs client:** Server Components for read-heavy pages, Client Components only for genuinely interactive parts. No global `S` object and no giant client state; the database is the source of truth and pages refresh after a mutation.
- **Transactions:** every multi-step change (card save, lines, imports, lock/unlock with history and audit) commits or rolls back as a whole.
- **Errors:** explicit status codes; never a success response for a failed mutation; no stack traces, secrets or infrastructure details to the client.
- **Assets:** never invent or silently replace a missing brand asset; report it.
- **Code:** straightforward TypeScript, no abstraction for its own sake, no duplicated business logic, authorization centralized.
- **Verification:** tests for costing, authorization (an API request without the permission fails even when the UI is bypassed), cycles, conversions, locking, audit and import validation, using real source data where possible. Compare screens and print output with the legacy app; working functionality is not proof of visual parity.
- **Docs:** keep `schema.md`, `docs/*` and `docs/PROGRESS.md` in step with the code in the same change.
