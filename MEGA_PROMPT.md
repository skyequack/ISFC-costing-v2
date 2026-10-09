# ISFC Food Costing System — Migration Agent Instructions

> **AMENDMENTS (authoritative, see DECISIONS.md D-01…D-50):** the 3-day deadline is removed (D-25); scope additions approved by the user override the "no new business rules" language in this document — editable menus (D-05), brand access across all brand-tied data (D-07), unique recipe codes (D-12), cycle blocking (D-13), extra auditing (D-15), yp/buffer round trip (D-17), unified "All sites" (D-20), price history & cost-at-lock (D-26), required brand on recipes (D-27), requisition valuation fix (D-10/D-28), lock gate (D-29). Permissions are the legacy ROLES list plus `menu.edit` (gm, cc) and GM-only `users.manage`, `data.admin`, `brands.edit`. Schema field names follow `schema.md`, not §13 here (e.g. `RecipeLine.y/yp`, `Ingredient.price`, `ItemBrandScope`, `MenuPax/ProductionEntry`). Real menu-planning model: see DISCOVERY_FINDINGS.md. **Data access (D-50): Prisma is NOT used.** The database is Neon PostgreSQL accessed with node-postgres (`pg`) and hand-written SQL; schema lives in `db/migrations/*.sql`; wherever this document says Prisma/ORM, read "pg + plain SQL".

You are the implementation agent responsible for converting the existing ISFC Food Costing System from a monolithic HTML application into a production-ready Next.js web application.

Your job is not to redesign the application.

Your job is not to reinterpret its business logic.

Your job is to migrate it.

The final application must use:

- Next.js
- TypeScript
- PostgreSQL on Neon via `pg` + plain SQL (no ORM)
- PostgreSQL
- Clerk
- Vercel
The existing `app.html` is the primary behavioral and visual reference.

`SOURCE_OF_TRUTH.md` is the authoritative project specification.

Read `SOURCE_OF_TRUTH.md` before making implementation decisions.

---

# 1. First task: inspect the existing application
Before writing application code, inspect the complete `app.html`.

Do not rely on a partial inspection.

Understand:

- the HTML structure
- CSS
- JavaScript
- global state
- state mutations
- persistence
- authentication
- authorization
- roles
- permissions
- brands
- ingredients
- conversions
- yields
- recipes
- sub-recipes
- recipe methods
- recipe locking
- recipe history
- menu planning
- production calculations
- requisition calculations
- printing
- import/export
- audit logging
- settings
- diagnostics
- seed data
- patches
- embedded assets
Map the existing functionality before replacing it.

Do not begin by inventing a new application architecture based on assumptions.

---

# 2. Establish the migration boundary
Treat the existing application as a legacy frontend and browser-local database.

The migration replaces:

```
HTML
+
JavaScript
+
global S object
+
localStorage
+
PIN authentication
```
with:

```
Next.js
+
React
+
TypeScript
+
node-postgres (pg), plain SQL
+
PostgreSQL
+
Clerk
```
Do not preserve the old browser-local architecture inside the new application.

Do not create a new global `S` object containing the entire application.

Do not make the browser the source of truth.

PostgreSQL must become the production source of truth.

---

# 3. Do not redesign the UI
This is one of the most important requirements.

The UI must remain the same.

The existing HTML and CSS define the visual target.

When converting HTML into React:

- preserve the existing structure where practical
- preserve class names where useful
- preserve CSS values
- preserve spacing
- preserve typography
- preserve colors
- preserve dimensions
- preserve tables
- preserve buttons
- preserve modals
- preserve navigation
- preserve cards
- preserve badges
- preserve terminology
- preserve print output
- preserve responsive behavior
Do not introduce a generic modern dashboard design.

Do not use Tailwind, shadcn, Material UI, Chakra, or another UI system merely because it is convenient.

If the existing CSS can be reused, reuse it.

If it needs to be converted into modules or shared styles, do so without changing its visual result.

The requirement is visual equivalence, not stylistic improvement.

---

# 4. Preserve the costing engine exactly
The costing system is business-critical.

Do not rewrite its mathematics from scratch.

Locate the existing costing functions.

Extract the relevant logic into pure TypeScript domain functions.

Initially preserve the existing algorithm as closely as possible.

Do not "fix" calculations because they appear unusual.

Do not assume that a different formula is more correct.

Do not change edge-case behavior without explicit approval.

The following existing concepts must be preserved:

```
lineCost
batch
cost
_cost
resolve
unit conversion
yield handling
sub-recipe resolution
cycle detection
```
Create automated tests around the migrated costing functions.

The target is behavioral equivalence.

---

# 5. Create the costing domain layer
Do not put costing mathematics inside React components.

Create a domain layer.

Use a structure similar to:

```
src/domain/costing/
    lineCost.ts
    batchCost.ts
    recipeCost.ts
    subRecipeCost.ts
    conversion.ts
    types.ts
```
The exact filenames may differ.

The important requirement is that costing is independent from:

- React
- browser APIs
- UI state
- Next.js components
- Clerk
- Database drivers and ORMs
The domain calculation should receive data and return calculations.

This makes it testable.

---

# 6. Prove costing equivalence
Before porting the entire UI, prove that the new costing engine produces the same results as the old engine.

Create a representative test set using the existing seed recipes.

Compare at least:

- line cost
- converted quantity
- yield-adjusted quantity
- ingredient cost
- sub-recipe cost
- batch cost
- total recipe cost
- selling price
- food-cost percentage
- packaging
- delivery
- labour
- operations
- buffer
- VAT
- final price
- net
- margin-related values
If the source implementation has unusual behavior, preserve it.

Document any intentional difference.

Do not proceed as though the migration is correct merely because TypeScript compiles.

---

# 7. Database migration rules
Use PostgreSQL on Neon through node-postgres (`pg`) with plain SQL.

Do not use SQLite for the production architecture.

Do not create a giant JSON blob representing `S`.

Use relational models.

However, do not over-normalize the source data.

Most importantly:

## NEVER AUTOMATICALLY MERGE INGREDIENTS.
If the source contains:

```
PRD-001
NC-001
```
they are separate records.

Even if they appear to represent the same physical product, keep them separate.

Do not deduplicate by:

- name
- code prefix
- description
- price
- unit
- brand
- inferred physical identity
Preserve every source record.

---

# 8. Preserve source identifiers
Existing ingredient codes must remain unchanged.

Existing recipe codes must remain traceable.

Do not silently regenerate identifiers during migration.

Database primary keys can be new internal IDs.

Business identifiers must remain preserved.

Maintain mappings where necessary:

```
legacy code
    ↓
database record
```
This is especially important for recipe lines and sub-recipes.

---

# 9. Do not introduce new business rules
Do not introduce new behavior because it seems useful.

Examples of prohibited scope expansion include:

- brand-specific costing settings
- new recipe versioning
- new approval workflows
- new financial rules
- new ingredient normalization
- new organization hierarchy
- new subscription logic
- new analytics
- new notification system
- new inventory system
- new procurement system
Implement the existing application first.

Future improvements can be added after V1.

---

# 10. CostSettings must remain global
The existing application has one global settings object.

Preserve this.

Do not make `CostSettings` brand-scoped.

Use one global settings record for V1.

Do not create separate settings for each brand unless explicitly instructed later.

---

# 11. Clerk authentication
Use Clerk for authentication.

Remove the old PIN authentication mechanism from the production architecture.

Do not recreate:

- user PIN login
- manager PIN approval
- browser-local security hashes
Clerk provides authenticated identity.

The application authorization layer determines what that authenticated identity can do.

The basic flow is:

```
Clerk
 ↓
authenticated user
 ↓
Clerk user ID
 ↓
application user
 ↓
role
 ↓
permissions
 ↓
brand access
```

---

# 12. Clerk roles
Roles will be configured in Clerk.

Use the six application roles:

```
gm
cc
fin
chef
cook
viewer
```
Clerk is authoritative for the user's role.

Do not create an independently editable database role that can contradict Clerk.

If the database stores role information for synchronization or querying, document the relationship clearly.

Never silently choose one value in one part of the system and another value elsewhere.

Create a centralized role resolver.

For example:

```
src/lib/auth/getCurrentUser.ts
src/lib/auth/getCurrentRole.ts
src/lib/auth/requirePermission.ts
```
Do not scatter Clerk role parsing across components.

---

# 13. Permission system
Keep the permission system centralized.

Initial mapping:

```
GM:
    *

COST_CONTROLLER:
    recipe.create
    recipe.edit
    recipe.delete
    recipe.price
    recipe.lock
    recipe.unlock
    items.edit
    conv.edit
    export
    audit.view

FINANCE:
    recipe.price
    items.edit
    settings.edit
    export
    audit.view

HEAD_CHEF:
    recipe.create
    recipe.edit
    recipe.lock
    export

CHEF:
    recipe.create
    recipe.edit
    export

VIEWER:
    export
```
Create a reusable authorization function.

For example:

```
requirePermission("recipe.edit")
```
A UI check such as:

```
can("recipe.edit")
```
may be used to hide or disable UI controls.

However, every protected API mutation must perform its own server-side authorization.

---

# 14. Brand authorization
Brand access must be checked on the server.

Never trust:

```
brandId
```
sent by the browser.

Resolve the authenticated user first.

Then determine whether the user has permission to access the requested brand.

GM users can access all brands.

Other users must have explicit brand access.

A malicious request such as:

```
PATCH /api/recipes/123
{
    "brandId": "another-brand"
}
```
must not bypass access control.

Authorization must happen before the database mutation.

---

# 15. Do not automatically use Clerk Organizations
Do not introduce Clerk Organizations unless the business requirement actually requires independent organizations or tenants.

Multiple brands do not automatically mean multiple Clerk Organizations.

Keep the V1 architecture simple.

Use application-level brand access.

---

# 16. API design
Create APIs around application operations.

Do not expose every database table as generic CRUD.

Prefer meaningful endpoints such as:

```
GET   /api/recipes/[id]
PATCH /api/recipes/[id]

POST  /api/recipes/[id]/lock
POST  /api/recipes/[id]/unlock

GET   /api/recipes/[id]/cost

GET   /api/ingredients
POST  /api/ingredients
PATCH /api/ingredients/[id]

GET   /api/menu-plans
POST  /api/menu-plans
PATCH /api/menu-plans/[id]
```
The exact API surface must be derived from the actual application workflows.

Do not create endpoints that expose arbitrary database mutations.

API handlers should call domain/application functions.

Do not put substantial business logic directly into route handlers.

---

# 17. Recommended API structure
A request should generally look like:

```
Route Handler
    ↓
Authentication
    ↓
Authorization
    ↓
Validation
    ↓
Application/domain operation
    ↓
Database access (pg)
    ↓
Audit logging
    ↓
Response
```
For complex mutations, use database transactions.

Examples:

Recipe update:

```
authenticate
 ↓
authorize recipe.edit
 ↓
validate recipe payload
 ↓
validate referenced ingredients/sub-recipes
 ↓
check brand access
 ↓
transaction
    update recipe
    replace/update lines
    update method
    create history
    create audit record
 ↓
response
```

---

# 18. Server Components and Client Components
Do not turn the entire application into a Client Component.

Use Server Components for read-heavy screens.

Examples:

```
dashboard
ingredient list
recipe list
brand list
audit log
settings
menu-plan overview
```
Use Client Components for genuinely interactive functionality.

Examples:

```
recipe editor
interactive costing
menu planning interface
complex forms
modal interactions
print preview
interactive filters
```
Avoid:

```
"use client"

entire application
```
Do not reproduce the old architecture as a giant React state object.

---

# 19. State management
Do not recreate:

```
let S = {
    ...
}
```
as a React equivalent.

Use local component state for temporary interaction.

Use server data for persistent state.

Use appropriate caching/revalidation mechanisms for server data.

The database is the source of truth.

After a mutation, the application should update or revalidate the relevant server data.

Do not keep an indefinitely stale copy of the database in browser memory.

---

# 20. Project structure
Use a clear separation of concerns.

A suitable structure is:

```
src/
├── app/
│   ├── api/
│   ├── dashboard/
│   ├── ingredients/
│   ├── recipes/
│   ├── brands/
│   ├── users/
│   ├── conversions/
│   ├── yields/
│   ├── menu-plans/
│   ├── production/
│   ├── audit/
│   └── settings/
│
├── components/
│   ├── layout/
│   ├── navigation/
│   ├── recipes/
│   ├── ingredients/
│   ├── menu-plans/
│   ├── production/
│   └── shared/
│
├── domain/
│   ├── costing/
│   ├── recipes/
│   ├── ingredients/
│   ├── menu-plans/
│   └── production/
│
├── lib/
│   ├── auth/
│   ├── permissions/
│   ├── db/
│   ├── validation/
│   └── utils/
│
└── styles/
```
Do not create files or abstractions solely to make the tree larger.

Prefer simple, readable code.

---

# 21. Data migration
Identify all seed constants and patches in the source.

These include concepts such as:

```
SEED_ITEMS
MASTER_PATCH
DEMO_RECIPES
RECIPE_PATCH
DEF_BRANDS
DEF_USERS
DEF_SETTINGS
DEF_SEC
```
Determine the final effective source data by applying the same patch semantics as the original application.

Then migrate that data into PostgreSQL.

The migration must be deterministic.

The migration must preserve source records.

The migration must report errors.

Do not silently discard records.

---

# 22. Migration traceability
Where practical, maintain a clear mapping between source data and database data.

For example:

```
Source:
PRD1-230

Database:
Ingredient.code = PRD1-230
```
If a transformation is unavoidable, document it.

Do not perform hidden transformations.

---

# 23. Recipe migration
Recipes must preserve:

- recipe code
- name
- category
- type
- brand
- output
- sub-recipe information
- batch output
- selling price
- status
- photo
- method
- recipe history where applicable
- recipe lines
Recipe lines must preserve:

- ingredient references
- sub-recipe references
- quantity
- unit
- yield
- order
Do not change recipe quantities during migration.

Do not convert units merely because another unit system appears cleaner.

---

# 24. Sub-recipes
Sub-recipes are first-class recipes.

A recipe can reference another recipe.

Preserve recursive costing.

Prevent circular references.

Do not flatten all sub-recipes into ingredients unless the source application already does so.

---

# 25. Unit conversions
Preserve the existing `S.conv` semantics.

Do not assume that:

```
factor
```
means the inverse of what the source uses.

Inspect the existing `lineCost()` implementation.

Write tests using real source examples.

Only then implement the database-backed conversion model.

---

# 26. Yield behavior
Preserve existing yield behavior.

If the original costing implementation treats unusual yield values in a particular way, reproduce that behavior.

Do not replace it with a new validation rule unless explicitly approved.

The domain layer may validate input for safety, but validation must not unintentionally alter established calculation semantics.

---

# 27. Audit logging
Audit records must be generated server-side.

Do not trust client-provided:

```
userName
role
userId
```
for audit identity.

Derive identity from Clerk.

Store snapshots where required so historical records remain understandable.

Audit logging must be append-oriented.

Do not allow ordinary users to delete audit records.

If the original application supports clearing the audit log, preserve the permission and require an appropriate confirmation workflow.

---

# 28. Recipe locking
Preserve the existing recipe locking behavior.

A locked recipe must enforce the same editing restrictions as the source application.

Do not replace locking with an unrelated versioning system.

Do not create a recipe-version architecture unless required by the source.

The existing status model is:

```
DRAFT
LOCKED
```
Preserve it.

---

# 29. Assets
Search the source file for embedded assets.

Extract usable base64 logos and other static assets into:

```
public/assets/
```
Do not invent missing assets.

If a required asset is absent or cannot be extracted correctly, stop and report it clearly.

Use a clear message such as:

```
MISSING ASSET:
<asset description>

Expected location:
<path>

Reason:
<why it is required>
```
Do not silently replace a missing company or brand asset with an unrelated placeholder.

---

# 30. Recipe photos
The source application stores recipe photos as base64 data.

Do not redesign the photo-storage architecture unless required for V1.

If necessary, preserve the representation initially.

Do not allow large image handling to break normal recipe queries.

If object storage is later introduced, treat it as a separate improvement.

Do not allow photo architecture to consume the majority of the three-day implementation window.

---

# 31. Import and export
Preserve the existing import/export behavior.

However, the production database is now the source of truth.

Do not treat localStorage JSON as the primary data store.

Import operations must:

1. authenticate the user
2. authorize the operation
3. validate the imported data
4. detect conflicts
5. use transactions where appropriate
6. report errors
7. write audit records when appropriate
Do not partially corrupt the database because one imported record is invalid.

---

# 32. Printing
Preserve the existing recipe-card print behavior.

Keep print CSS separate from normal UI styling where practical.

Test actual browser printing.

Do not assume that matching the screen UI automatically means matching the printed output.

---

# 33. Vercel compatibility
The application must be compatible with Vercel serverless execution.

Do not use persistent in-memory server state.

Do not write application data to the local filesystem.

Do not rely on a long-running server process.

Do not use local SQLite as the production database.

Use PostgreSQL.

Configure node-postgres and Neon pooling appropriately for serverless execution.

All secrets must be environment variables.

---

# 34. Do not add Python
Do not introduce a Python backend.

The required architecture is:

```
Browser
   ↓
Next.js
   ↓
Clerk authentication
   ↓
Authorization
   ↓
Application/domain logic
   ↓
node-postgres (pg), plain SQL
   ↓
PostgreSQL
```
Python is only acceptable if the developer can identify a concrete requirement that cannot reasonably be implemented in Next.js.

Do not add Python simply because it is familiar or because a separate backend appears architecturally cleaner.

For this three-day migration, an additional backend is more likely to increase complexity than reduce it.

---

# 35. Three-day execution strategy
The implementation has a strict three-day deadline.

Optimize for:

```
working
correct
testable
deployable
maintainable
```
Do not optimize for:

```
maximum abstraction
maximum normalization
maximum framework complexity
future features
```
Recommended order:

## Phase 1 — Foundation
Set up:

- Next.js
- TypeScript
- Clerk
- PostgreSQL on Neon via `pg` + plain SQL (no ORM)
- PostgreSQL
- environment configuration
- basic application layout
- authentication
- authorization foundation

## Phase 2 — Vertical slice
Implement:

```
Ingredient
 ↓
Recipe
 ↓
Recipe lines
 ↓
Costing
 ↓
API
 ↓
Database access (pg)
 ↓
PostgreSQL
 ↓
Reload
```
Verify the result against the source.

## Phase 3 — UI migration
Port the existing screens.

Prioritize the screens that prove the core system:

```
Dashboard
Ingredients
Recipes
Recipe Editor
Menu Planning
Production
Requisition
```
Then migrate:

```
Brands
Users
Conversions
Audit
Settings
Backup
Diagnostics
```

## Phase 4 — Production
Deploy to Vercel.

Run production smoke tests.

Test:

- login
- role handling
- ingredient edit
- recipe edit
- recipe cost
- recipe lock/unlock
- menu planning
- production
- audit
- export/import
- printing
Test from a second browser/device to confirm PostgreSQL persistence.

---

# 36. Do not wait until the end to discover architectural failures
The vertical slice is mandatory.

Do not spend the entire first day building:

```
database
auth
API
components
```
independently.

Connect them early.

The following must work before broad UI migration:

```
Clerk
 ↓
Next.js
 ↓
authorization
 ↓
API
 ↓
Database access (pg)
 ↓
PostgreSQL
 ↓
recipe
 ↓
cost calculation
```

---

# 37. Testing strategy
Create tests for the domain logic.

Prioritize costing tests.

Create authorization tests.

For every important permission, verify that an unauthorized API request fails even when the UI is bypassed.

Test database relationships.

Test sub-recipe cycles.

Test conversion behavior.

Test recipe locking.

Test audit creation.

Test import validation.

Use real source data for regression tests wherever possible.

---

# 38. Visual verification
The old application is the visual baseline.

For each migrated screen:

1. Open the original.
2. Open the new implementation.
3. Compare layout.
4. Compare typography.
5. Compare spacing.
6. Compare colors.
7. Compare controls.
8. Compare tables.
9. Compare modals.
10. Compare responsive behavior.
11. Compare print output where applicable.
Do not declare the UI complete merely because the functionality works.

---

# 39. Error handling
Errors must be explicit.

Do not swallow exceptions.

Do not return successful HTTP responses when a mutation failed.

Use appropriate status codes.

Return useful error information to the client without exposing:

- database credentials
- stack traces
- secrets
- internal infrastructure details
Log useful server-side diagnostic information.

---

# 40. Database safety
Use database transactions for multi-step operations that must succeed or fail together.

Examples:

- recipe updates
- recipe line replacement
- imports
- locking/unlocking when history and audit records are created
- operations affecting multiple related records
Do not leave partially migrated or partially updated recipes.

---

# 41. Code quality
Write straightforward TypeScript.

Avoid unnecessary abstraction.

Avoid premature optimization.

Avoid duplicated business logic.

Avoid magic constants where existing business rules should be named.

Keep domain logic independent from UI.

Keep database access out of reusable UI components.

Keep authorization centralized.

---

# 42. What not to do
Do NOT:

- redesign the UI
- replace the costing engine with new formulas
- merge ingredients
- deduplicate ingredients
- rename source ingredient codes
- invent business rules
- make settings brand-specific
- recreate PIN authentication
- add Python
- add Clerk Organizations without a requirement
- create a generic CRUD API for every model
- make the entire app a Client Component
- recreate the global `S` object
- use localStorage as production persistence
- use SQLite as the production database
- silently repair source data
- silently discard migration errors
- silently replace missing assets
- build speculative features
- introduce microservices
- spend the three-day window on unnecessary infrastructure

---

# 43. When uncertain
When an implementation decision is unclear:

1. Inspect the existing application.
2. Search `SOURCE_OF_TRUTH.md`.
3. Prefer existing behavior.
4. Prefer the simplest architecture compatible with the requirements.
5. Do not invent a new business rule.
6. Do not silently make a destructive data transformation.
7. If the decision could affect existing data or costing, stop and report it.
Do not optimize the application by changing its meaning.

---

# 44. Required documentation
Maintain:

```
SOURCE_OF_TRUTH.md
plan.md
schema.md
```
Before major implementation work, ensure `plan.md` and `schema.md` reflect the current agreed architecture.

If the architecture changes during implementation, update the documents.

Do not allow the implementation and documentation to silently diverge.

---

# 45. Final acceptance criteria
The finished application must satisfy all of the following:

```
[ ] Next.js application runs
[ ] TypeScript builds without errors
[ ] Clerk authentication works
[ ] Clerk role resolution works
[ ] Permissions are enforced server-side
[ ] Brand access is enforced server-side
[ ] node-postgres + Neon works
[ ] PostgreSQL works
[ ] Existing ingredient codes are preserved
[ ] Existing ingredient records are not merged
[ ] Existing recipe data is preserved
[ ] Recipe lines are preserved
[ ] Sub-recipes work
[ ] Unit conversions work
[ ] Yield calculations work
[ ] Costing matches the source
[ ] Recipe locking works
[ ] Menu planning works
[ ] Production calculations work
[ ] Requisition generation works
[ ] Audit logging works
[ ] Import works
[ ] Export works
[ ] Printing works
[ ] Existing visual appearance is preserved
[ ] Assets are preserved or explicitly reported as missing
[ ] No production dependency on localStorage exists
[ ] Application works across devices
[ ] Application deploys successfully to Vercel
[ ] Production smoke tests pass
```
The final implementation should be a proper web application, not a React wrapper around the original HTML.

However, do not rewrite functionality merely for the sake of rewriting it.

The correct approach is:

```
Preserve the behavior.
Preserve the UI.
Replace the architecture.
Prove the critical paths.
Deploy.
```
Start by inspecting the existing `app.html` and the current project files.

Do not begin broad implementation until you understand the existing application.

After inspection, create or update `plan.md` and `schema.md` as necessary.

Then begin with the smallest complete vertical slice:

```
Ingredient → Recipe → Cost → Save → Reload
```
Once that works correctly, expand the implementation to the remaining application features.

These two files give the agent a much tighter contract: **`SOURCE_OF_TRUTH.md` says what the system must be; `MEGA_PROMPT.md` says how the agent must build it.**
