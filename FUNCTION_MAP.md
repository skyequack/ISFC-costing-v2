# FUNCTION_MAP.md — legacy function groups → where they live now

Line numbers are in `legacy/app.html` (approximate; exact numbers are in `docs/legacy/FUNCTION_INDEX.md`). Each screen is a page in `src/app/<route>/page.tsx` (data from `src/lib/screens/*`) that renders a component from `src/components/*`; mutations go through `src/app/api/**` → `src/lib/services/*`.

| Legacy area (lines) | Now |
|---|---|
| Cost engine: `resolve, lineCost, batch, subUnitCost, cost, _cost, num` (1362–1480) | `src/domain/costing/engine.ts` (pure; oracle-tested against `golden/costs.json`) |
| `reqExpand, reqForDay` (2093–2260) | `src/domain/production/{requisition,day}.ts` |
| `prepDemand, menuDemand, menuPreview, planFindCard, planCost` (1640–1740) | `src/domain/menu-plans/index.ts` |
| `ROLES, can, guard, enforce` (550–640) | `src/lib/permissions.ts`, `withAuth` (`src/lib/auth/with-auth.ts`), `<Perm>` (`src/components/shared/Perm.tsx`) |
| Login / PIN / `requireAuth` / `hashPin` / `resetAccess` (644–770, 1160–1220) | **Removed** (Clerk: `src/lib/auth/session.ts`, `src/middleware.ts`) |
| `vUsers, saveUser, toggle, delete` (773–950) | `UsersScreen.tsx`, `src/lib/services/users.ts`, Clerk port `src/lib/auth/clerk-port.ts` |
| `vAudit, logit` (954–1000, 631) | `AuditScreen` in `SimpleScreens.tsx`, `src/lib/db/repo/audit.ts`, `src/lib/services/audit.ts` |
| Palette: `hex2rgb … palette, brandVars` (1235–1300) | `src/lib/brand/palette.ts` (verbatim) |
| `itemFor/itemBrands/brandStock` (1303) | `src/domain/ingredients`, `src/lib/db/repo/ingredients.ts` |
| `readPhoto` (1313), photo handlers (3440–3460) | `src/components/shared/images.ts`, `src/app/api/recipes/[id]/photo`, `src/lib/images/*` |
| `Store/save/seed/boot IIFE` (1080–1150, 6103–6570) | **Replaced** by Postgres + `db/migrations`, `scripts/seed.mjs` → `src/lib/seed/seed.ts` (final state only) |
| Nav/render/route/modal/toast (1520–1760) | `src/lib/nav.ts`, `src/components/shell/Shell.tsx`, `src/components/shared/{Modal,Toast}.tsx` |
| `vPrep, prepPrint, prepCsv` (1758–1920) | `PrepScreen.tsx`, `src/lib/print/prod.ts`, export kind `prep` |
| `vPlan, planCsv, setMenuPrice` (1923–2050) | `PlanScreen.tsx`, `src/lib/services/planning.ts`, `/api/menus`, `/api/menu-price` |
| `vProd, vReq, prodPrint*, prodCsv, reqCsv, applyMenuDay` (2051–2560) | `ProdScreen.tsx`, `src/lib/services/{planning,planning-apply}.ts`, `src/lib/print/prod.ts`, `/api/export/[kind]` |
| `vBrands` (2564), Settings brand management (4118–4280) | `BrandsScreen.tsx`, `SettingsScreen.tsx`, `src/lib/services/brands.ts` |
| `vDash` (2614) | `DashScreen.tsx` (+ `DashAnalyticsPanel.tsx`, D-65…), `src/lib/screens/dash.ts`, `src/domain/dash-analytics` |
| `vRecipes, vEdit, vLocked, newRecipe, nextCode, dup, delete, lock/unlock, bulk*` (2752–3730) | `RecipesScreen.tsx`, `src/components/recipes/*`, `/api/recipes/**`, `src/lib/services/recipes.ts`, `src/domain/recipes` |
| `vItems, saveItem, delItem`, item importer (3730–3860, 4660–4830) | `ItemsScreen.tsx`, `/api/ingredients/**`, `src/lib/import/items.ts`, `src/lib/services/{ingredients,import-items}.ts` |
| `vConv, saveConv` (3887–4064) | `ConvScreen.tsx`, `/api/conversions` |
| `vYields` (4068) | `YieldsScreen` in `SimpleScreens.tsx` (static `YIELD_REF` in `src/data`) |
| `vSettings` (4085) | `SettingsScreen.tsx`, `src/lib/services/settings.ts` |
| `vHealth` (4318) | `HealthScreen` in `SimpleScreens.tsx`, `src/lib/screens/health.ts` |
| `vBackup, exportAll, doRestore, doReset`, CSV exports (4371–4600) | `BackupScreen.tsx`, `src/components/io/*`, `src/lib/services/{backup,restore,exports}.ts` (reset/rebuild not ported, D-54) |
| XLSX writer/reader, recipe import/export (4852–5430, 5528–5840) | `src/lib/xlsx/*`, `src/lib/import/recipes.ts`, `src/lib/services/import-recipes.ts` |
| `printCard, buildCardHTML, cardDocument` (5860–6100) | `src/lib/print/card.ts`, `src/components/recipes/print.tsx`, `src/styles/print.css` |
