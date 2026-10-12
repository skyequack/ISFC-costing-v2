# ISFC Food Costing System — Source of Truth (condensed)

The original V1 migration spec (what the system must be). The migration is complete, so this is now a short list of the standing requirements; the full original is in git history (`git show d9f05e3:SOURCE_OF_TRUTH.md`). **`DECISIONS.md` overrides this file**, and `DISCOVERY_FINDINGS.md` §2 records where the spec was wrong about the legacy app (for example, there is no MenuPlan/MenuPlanItem model). Schema names follow `schema.md` and `db/migrations/`.

**Stack:** Next.js App Router + TypeScript · PostgreSQL on Neon through `pg` with plain SQL (no ORM, D-50) · Clerk · Vercel. The behavioral and visual reference is `legacy/app.html`.

## Standing requirements
- **UI:** visually equivalent to the legacy app: layout, spacing, typography, colors, tables, modals, navigation, print layouts and terminology. No new visual language or dashboard template.
- **Costing:** `lineCost`, `batch`, `cost`, `_cost`, `resolve`, sub-recipe recursion, cycle detection, unit conversion and yield behave exactly as in the legacy app. Reproduce first, then test; never "correct" a formula without approval.
- **Data:** never merge or deduplicate ingredients (each source code is a distinct record), never rename or regenerate codes, keep data-quality flags (`PRICE CHECK`, `UNIT CHECK`, `NO CODE in source`, …) verbatim.
- **Static data:** `YIELD_REF` ships as static application data (no table, no CRUD).
- **Cost settings:** one global record, not per brand.
- **Auth:** Clerk only; no PIN or manager PIN. Roles `gm, cc, fin, chef, cook, viewer` are authoritative in Clerk; the database never holds a second, editable role.
- **Permissions:** a central mapping in code (`src/lib/permissions.ts`), checked on the server for every mutation; client `can()` is cosmetic.
- **Brand access:** application-level (not Clerk Organizations). GM sees every brand, others only the brands granted to them, always checked on the server; ids from the browser are never trusted.
- **Request pipeline:** session → user → role → permission → brand/resource access → validation (Zod) → domain operation in a transaction → audit row → response.
- **Audit:** written on the server with identity from the session, append-only, readable after the user is deactivated.
- **Deletion:** soft delete where the legacy app implies reversibility.
- **Runtime:** Vercel serverless; no filesystem persistence, in-memory state or `localStorage` as source of truth. Pooled Neon URL for the app, unpooled for migrations. Secrets only in environment variables.
- **No Python** and no second backend.
- **Done means:** costs match the legacy app, permissions and brand access are enforced on the server, data persists across devices, and no unapproved business-rule change was introduced.
