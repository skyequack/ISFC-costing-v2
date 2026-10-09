# ISFC Food Costing System — Source of Truth

> **AMENDMENTS (authoritative, see DECISIONS.md D-01…D-41):** the 3-day deadline is removed (D-25); scope additions approved by the user override the "no new business rules" language in this document — editable menus (D-05), brand access across all brand-tied data (D-07), unique recipe codes (D-12), cycle blocking (D-13), extra auditing (D-15), yp/buffer round trip (D-17), unified "All sites" (D-20), price history & cost-at-lock (D-26), required brand on recipes (D-27), requisition valuation fix (D-10/D-28), lock gate (D-29). Permissions are the legacy ROLES list plus `menu.edit` (gm, cc) and GM-only `users.manage`, `data.admin`, `brands.edit`. Schema field names follow `schema.md`, not §13 here (e.g. `RecipeLine.y/yp`, `Ingredient.price`, `ItemBrandScope`, `MenuPax/ProductionEntry`). Real menu-planning model: see DISCOVERY_FINDINGS.md.

**Status:** Authoritative V1 specification
**Target stack:** Next.js + TypeScript + Prisma 6 + PostgreSQL + Clerk + Vercel
**Primary requirement:** Preserve the existing application's behavior and UI while replacing its browser-local architecture with a production web application.

---

# 1. Project Objective
The existing ISFC Food Costing System is a monolithic HTML application containing its HTML, CSS, JavaScript, application state, business logic, authentication logic, seed data, and assets in one file.

The V1 objective is to migrate this application into a proper production-ready web application.

The target application must:

- use Next.js with the App Router
- use TypeScript
- use Prisma 6
- use PostgreSQL
- use Clerk for authentication
- use Clerk roles as the authoritative source for application roles
- enforce authorization on the server
- support role-based permissions
- support brand access control
- expose application functionality through API endpoints where appropriate
- work correctly when deployed to Vercel
- persist data in PostgreSQL
- preserve the existing costing calculations
- preserve the existing workflows
- preserve the existing terminology
- preserve the existing UI as closely as technically possible
- support multiple authenticated users and devices
- remove the browser-only `localStorage` state architecture
The migration is not a redesign.

The migration is not a data-cleanup project.

The migration is not an opportunity to invent new business rules.

---

# 2. Existing Application
The source application is `app.html`.

The source application is the behavioral and visual reference for V1.

The agent must inspect the entire source before making architectural decisions.

The source contains:

- HTML
- CSS
- JavaScript
- application state
- costing calculations
- authentication
- authorization
- recipe management
- ingredient management
- brands
- conversions
- yields
- menu planning
- production planning
- requisitions
- printing
- import/export
- audit logging
- settings
- health/diagnostic functionality
- seed data
- patches
- embedded assets
The application currently uses a global state object called `S`.

The current state contains concepts including:

```
items
conv
recipes
brands
users
security
settings
audit
activeBrand
seq
```
The existing application persists this state through `localStorage` using:

```
isfc_costing_v1
```
Some environments use a `window.storage` fallback.

The V1 application must replace this browser-local persistence with PostgreSQL.

---

# 3. Non-Negotiable Requirements

## 3.1 UI preservation
The UI must remain visually equivalent to the existing application.

Do not redesign the interface.

Do not introduce a new visual language.

Do not replace the existing layout with a generic dashboard template.

Do not replace existing terminology.

Do not change workflows merely because a different implementation appears cleaner.

Use the source HTML and CSS as the visual reference.

Preserve:

- layout
- spacing
- typography
- colors
- borders
- shadows
- tables
- cards
- buttons
- modals
- badges
- navigation
- icons
- print layouts
- responsive behavior
- terminology
React components are an implementation detail.

The user-facing result should remain the same.

---

## 3.2 Costing behavior preservation
The costing engine is business-critical.

The existing costing behavior is authoritative.

Do not redesign or simplify the costing formulas.

Do not "correct" calculations because they appear unusual.

Do not replace existing edge-case behavior with assumptions.

First reproduce the existing behavior.

Then test it.

Any later optimization or refactoring must preserve the verified output.

The existing functions around:

```
lineCost
batch
cost
_cost
resolve
```
must be treated as behavioral references.

Sub-recipe recursion and cycle detection must be preserved.

Unit conversion behavior must be preserved.

Yield behavior must be preserved.

---

# 4. Data Migration Rules

## 4.1 Do not deduplicate ingredients
Every existing ingredient code is a distinct source record.

Do not merge records because:

- their names are similar
- their descriptions are similar
- their prices are similar
- their units are similar
- they appear to represent the same physical ingredient
- one appears to be a brand-specific copy
- the agent believes normalization would be better
For example:

```
PRD-001 → 10 SAR/kg
NC-001  → 12 SAR/kg
```
must remain two distinct records unless explicitly approved for merging.

Data normalization is not part of V1 migration.

Every migrated ingredient must remain traceable to its source code.

---

## 4.2 Preserve existing codes
Do not automatically:

- rename codes
- change codes
- regenerate codes
- remove prefixes
- change capitalization
- replace legacy codes
- infer missing codes
Existing codes must remain unchanged unless the user explicitly approves a change.

---

## 4.3 Preserve existing data-quality flags
Existing flags are part of the source data.

Examples include:

```
PRICE CHECK - ...
UNIT CHECK - ...
NO CODE in source
PRICE MISSING
SMC copy - ...
```
Do not silently fix these.

Carry them into the new database.

If a value appears incorrect, preserve the original value and report the issue.

---

# 5. Existing Static Reference Data
`YIELD_REF` is a static reference table.

It is not user-owned application data.

Do not create a database table for it in V1.

Ship it as static application data.

Do not add CRUD functionality for it.

A future requirement can introduce a database-backed version.

---

# 6. Cost Settings
The existing application contains one global settings object.

V1 must preserve this behavior.

Use one global `CostSettings` record.

Do not make settings brand-specific in V1.

Do not invent the rule that different brands can have different:

- packaging percentages
- delivery percentages
- labour percentages
- operations percentages
- buffer percentages
- target food-cost percentages
- VAT percentages
- currencies
The schema may be designed so that future brand-specific settings are possible.

Do not implement brand-specific settings now.

---

# 7. Authentication
Clerk is the authentication system.

The old PIN authentication must not be recreated.

The old manager PIN must not be recreated as a second authentication mechanism.

The authentication architecture is:

```
User
 ↓
Clerk
 ↓
Authenticated session
 ↓
Clerk user ID
 ↓
Application User
```
Clerk establishes identity.

The application establishes authorization.

---

# 8. Roles
The existing role concepts are:

```
gm
cc
fin
chef
cook
viewer
```
Their intended meanings are:

```
gm    = General Manager
cc    = Cost Controller
fin   = Finance
chef  = Head Chef
cook  = Chef
viewer = Viewer
```
The role is authoritative in Clerk.

Do not create two independently editable role systems.

If Prisma stores a role field for application convenience or synchronization, the implementation must explicitly document that Clerk is authoritative.

The application must never silently allow Clerk and Prisma to disagree.

---

# 9. Permissions
Permissions are application logic.

They should be represented in code rather than as an administrator-editable database table for V1.

The initial permission mapping is:

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
Centralize this mapping.

Use authorization helpers such as:

```
requirePermission("recipe.edit")
```
Do not duplicate role checks throughout the application.

---

# 10. Brand Access
Brands are application entities.

Brands are not automatically Clerk Organizations.

Do not introduce Clerk Organizations unless a genuine multi-organization requirement is identified.

A non-GM user can have access to specific brands.

The conceptual model is:

```
User
 ├── Role
 └── Brand Access
        ├── Brand A
        ├── Brand B
        └── Brand C
```
GM users have access to all brands.

Brand access must be checked server-side.

A user must not gain access to another brand by changing a URL, request body, query parameter, or API request.

---

# 11. Authorization Request Pipeline
Every protected mutation must follow this general pipeline:

```
Request
 ↓
Validate Clerk session
 ↓
Identify Clerk user
 ↓
Resolve application user
 ↓
Resolve role
 ↓
Check permission
 ↓
Check brand/resource access
 ↓
Validate request data
 ↓
Execute domain operation
 ↓
Execute Prisma transaction where required
 ↓
Create audit entry where required
 ↓
Return response
```
Client-side permission checks are only for UI behavior.

They are not security controls.

---

# 12. Database Architecture
The database is PostgreSQL.

Prisma version is 6.

The database is the source of truth for persistent application data.

Do not recreate the old global `S` object as a giant database document.

Use relational models.

The schema should preserve source behavior without prematurely normalizing business data.

---

# 13. Core Database Models
The V1 database should contain the following core concepts.

## Brand
Represents a brand.

Fields include:

```
id
code
name
nameAr
color
inkColor
logoUrl
locations
active
createdAt
updatedAt
```
The exact fields may be adjusted after inspecting the source.

---

## User
Represents an application user mapped to a Clerk identity.

Fields include:

```
id
clerkUserId
name
active
createdAt
updatedAt
```
If a role is also stored in Prisma, Clerk remains authoritative.

Do not create independent role-management behavior in Prisma.

---

## UserBrandAccess
Maps users to brands.

Required relationship:

```
User ↔ Brand
```
Use a unique constraint on:

```
userId + brandId
```

---

## Ingredient
Represents one source ingredient record.

Every existing source ingredient code must remain distinct.

Fields include concepts such as:

```
id
code
name
uom
basePrice
category
subcategory
flag
masterRevision
createdAt
updatedAt
```
`code` must be unique.

Do not merge existing records during migration.

---

## IngredientBrand
This may be used to support future or existing brand-specific overrides.

However, introducing this relationship must not cause source records to be merged.

An ingredient override is different from an ingredient identity.

If the source contains two distinct ingredient codes, keep two Ingredient records even if they later receive similar brand relationships.

---

## UnitConversion
Represents conversion information currently held in `S.conv`.

Concepts include:

```
ingredient
recipeUnit
factor
```
Preserve the original conversion semantics.

Do not reverse factors merely because another convention seems more intuitive.

The costing engine is authoritative.

---

## Recipe
Represents a recipe or menu card.

Concepts include:

```
id
code
name
category
type
brandId
output
subQty
subUom
batchOut
batchUom
sellingPrice
photoUrl
status
lockedByUserId
lockedAt
createdAt
updatedAt
deletedAt
```
Recipe types:

```
MENU
SUB
```
Recipe statuses:

```
DRAFT
LOCKED
```

---

## RecipeLine
Represents a recipe component.

A line references either:

```
Ingredient
```
or:

```
Sub-recipe
```
It contains:

```
quantity
unit
yieldPct
sortOrder
```
The application must prevent a line from referencing both an ingredient and a sub-recipe.

The application must also prevent a line from referencing neither.

---

## RecipeMethodStep
Represents one ordered recipe method instruction.

Fields:

```
id
recipeId
stepNumber
text
```

---

## RecipeHistoryEntry
Represents the lightweight history associated with a recipe.

Fields include:

```
id
recipeId
userId
action
createdAt
```
This is distinct from the global audit log.

---

## CostSettings
V1 contains one global settings record.

It includes the existing costing settings such as:

```
currency
packagingPct
deliveryPct
labourPct
opsPct
bufferPct
targetFoodCostPct
vatPct
priceDate
```
Do not scope it to a brand in V1.

---

## AuditLog
Represents the global audit history.

It should be append-only under normal application behavior.

Concepts include:

```
id
userId
userNameSnapshot
roleSnapshot
action
detail
createdAt
```
Audit records must survive user deactivation.

The system should not depend on the current user profile to interpret an old audit record.

---

## MenuPlan
Represents a brand's planning period.

The exact date representation must follow the existing application's actual planning behavior.

---

## MenuPlanItem
Represents a recipe assigned to a date within a menu plan.

Concepts include:

```
menuPlanId
recipeId
date
location
pax
```
The existing production and requisition calculations must continue to operate against these values.

---

# 14. Recipe and Sub-Recipe Relationships
A recipe can contain:

```
Ingredient
```
or:

```
Sub-recipe
```
Sub-recipes can themselves contain ingredients or other sub-recipes.

The costing engine must recursively resolve sub-recipes.

Cycle detection must be retained.

Example:

```
Recipe A
 ↓
Recipe B
 ↓
Recipe C
```
is valid.

This is invalid:

```
Recipe A
 ↓
Recipe B
 ↓
Recipe A
```
The application must detect the cycle rather than recursively executing forever.

---

# 15. API Architecture
Use Next.js Route Handlers for API functionality.

Prefer application-level endpoints over generic CRUD endpoints.

Good examples:

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
Do not create endpoints merely because a Prisma model exists.

An endpoint should represent a meaningful application operation.

---

# 16. Validation
Use a validation layer such as Zod.

Validate API input before database operations.

Validation must cover:

- required fields
- types
- numeric ranges where required
- dates
- IDs
- recipe line structure
- ingredient/sub-recipe exclusivity
- permission requirements
- brand access
- business rules
Do not rely on TypeScript types for runtime validation.

---

# 17. Next.js Architecture
Use the App Router.

Prefer Server Components for read-heavy pages.

Use Client Components for genuinely interactive interfaces.

Do not make the entire application one Client Component.

Do not recreate the global `S` state object in React.

The conceptual architecture is:

```
Server Component
    ↓
Database read
    ↓
Props
    ↓
Client Component
    ↓
Interactive state
    ↓
API mutation
    ↓
Authorization
    ↓
Domain logic
    ↓
Prisma
    ↓
PostgreSQL
```

---

# 18. Suggested Project Structure
Use a structure similar to:

```
src/
├── app/
│   ├── api/
│   │   ├── ingredients/
│   │   ├── recipes/
│   │   ├── brands/
│   │   ├── menu-plans/
│   │   ├── conversions/
│   │   ├── audit/
│   │   └── settings/
│   │
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
│   ├── audit/
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
This is a guideline.

Do not create unnecessary abstractions merely to satisfy this tree.

---

# 19. Assets
Inspect the existing HTML for embedded assets.

UI logos and brand logos embedded as base64 should be extracted into appropriate static assets where practical.

Use:

```
public/assets/
```
for static assets.

Do not invent missing logos.

If an asset is genuinely missing or unusable, report it clearly and request it.

Recipe photos currently exist as base64 data.

Do not make a V1 rewrite of the photo system unless necessary.

A later migration to object storage is acceptable.

---

# 20. Import and Export
The existing application has import/export functionality.

Preserve this functionality.

The new system must not export a browser-local `S` object as the primary persistence mechanism.

Database-backed data must remain the source of truth.

Import functionality must validate imported data before modifying production records.

Prefer transactional imports for multi-record operations.

---

# 21. Printing
Recipe-card printing is part of the existing functionality.

Preserve the printed output as closely as possible.

Do not redesign print cards.

Keep print-specific CSS isolated from normal application UI where practical.

---

# 22. Audit Logging
Actions that currently generate audit records must continue to generate audit records.

Examples include:

- ingredient price changes
- recipe changes
- recipe deletion
- recipe locking
- recipe unlocking
- user changes
- settings changes
- other existing audited actions
Audit logging should happen server-side.

Do not trust a client-provided username or role for an audit record.

The server should derive the acting identity from the authenticated Clerk session.

---

# 23. Deletion
Prefer soft deletion where the existing application implies reversibility.

Do not permanently destroy historical records unnecessarily.

Audit history must remain available after normal record deactivation/deletion.

Where a hard delete is required, use appropriate relational constraints.

---

# 24. Vercel Requirements
The application must run correctly in a serverless Vercel environment.

Do not depend on:

- local filesystem persistence
- long-running processes
- in-memory server state
- local SQLite files
- persistent Node processes
- browser-local storage as the source of truth
Use environment variables for secrets and credentials.

Use a PostgreSQL deployment suitable for serverless workloads.

Use an appropriate Prisma connection strategy for Vercel.

---

# 25. No Python Backend
Python is not part of the V1 architecture.

Do not introduce Python unless a concrete requirement is identified that cannot reasonably be implemented in the target Next.js architecture.

The default stack remains:

```
Next.js
TypeScript
Prisma 6
PostgreSQL
Clerk
Vercel
```
Adding another backend would add another runtime, API boundary, authentication boundary, deployment target, and debugging surface.

That is undesirable for the current three-day implementation.

---

# 26. Three-Day Scope
The implementation has a three-day deadline.

The priority is a functioning production-ready V1.

Do not spend the majority of the available time on speculative architecture.

The implementation order should prioritize:

```
1. Project initialization
2. Next.js shell
3. Clerk authentication
4. Prisma/PostgreSQL connection
5. Authorization foundation
6. Database migration
7. Ingredient vertical slice
8. Recipe vertical slice
9. Costing engine
10. Save/reload workflow
11. UI migration
12. Remaining workflows
13. Vercel deployment
14. Production verification
```

---

# 27. Vertical Slice Requirement
The first complete functional slice should prove:

```
Ingredient
    ↓
Recipe
    ↓
Recipe Line
    ↓
Cost Calculation
    ↓
Save
    ↓
PostgreSQL
    ↓
Reload
    ↓
Cost Calculation
```
Do not spend the first day creating a large amount of disconnected infrastructure.

Prove one complete workflow first.

---

# 28. Testing Requirements
At minimum, test:

- authentication
- role resolution
- permission enforcement
- brand access
- ingredient reads
- ingredient writes
- recipe creation
- recipe editing
- recipe locking
- recipe unlocking
- sub-recipes
- unit conversion
- yields
- costing
- menu planning
- production calculations
- requisitions
- printing
- import
- export
- audit logging
- settings
- Vercel deployment
The costing engine must have regression tests against the original implementation.

---

# 29. Migration Principle
The migration should follow:

```
Understand
 ↓
Preserve
 ↓
Extract
 ↓
Test
 ↓
Migrate
 ↓
Rebuild
 ↓
Compare
 ↓
Deploy
```
Do not follow:

```
Redesign
 ↓
Normalize
 ↓
Rewrite
 ↓
Hope it matches
```

---

# 30. Definition of Done
V1 is complete when:

1. A user can authenticate with Clerk.
2. The application correctly identifies the user's role.
3. Permissions are enforced server-side.
4. Brand access is enforced server-side.
5. Ingredients persist in PostgreSQL.
6. Existing ingredient codes remain distinct and traceable.
7. Recipes persist in PostgreSQL.
8. Recipe lines persist correctly.
9. Sub-recipes work.
10. Cost calculations match the source application.
11. Menu planning works.
12. Production and requisition workflows work.
13. Audit logging works.
14. Import/export works.
15. Printing works.
16. The UI remains visually equivalent to the original.
17. The application can be deployed to Vercel.
18. The application works across multiple browsers/devices.
19. No browser `localStorage` state is required for production persistence.
20. No unapproved business-rule changes have been introduced.
The original `app.html` remains the behavioral reference.

This document is the architectural and behavioral source of truth.

When implementation convenience conflicts with preserving existing behavior, preserve existing behavior unless the change is explicitly approved.


