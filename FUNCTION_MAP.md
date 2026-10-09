# FUNCTION_MAP.md — legacy function groups → destination (line numbers in legacy/app.html)

| Legacy area (lines) | Destination |
|---|---|
| Cost engine: `resolve, lineCost, batch, subUnitCost, cost, _cost, num` (1362–1480) | `src/domain/costing/*` (pure; oracle-tested vs `golden/costs.json`) |
| `reqExpand, reqForDay, prepDemand, menuDemand, menuPreview, planFindCard, planCost` (1640–1740, 2093–2260) | `src/domain/production/*`, `src/domain/menu-plans/*` |
| `ROLES, can, guard, enforce` (550–640) | `src/lib/permissions`, `requirePermission`, client `can()` |
| Login / PIN / `requireAuth` / `hashPin` / `resetAccess` (644–770, 1160–1220) | **Removed** (Clerk) |
| `vUsers, saveUser, toggle, delete` (773–950) | `app/users` + Clerk Backend API + `User/UserBrandAccess` |
| `vAudit, logit` (954–1000, 631) | `app/audit`, `lib/audit.ts` |
| Palette: `hex2rgb … palette, brandVars` (1235–1300) | `src/lib/brandPalette.ts` (pure, copy verbatim) |
| `itemFor/itemBrands/brandStock` (1303) | `domain/ingredients` |
| `readPhoto` (1313), photo handlers (3440–3460) | client util + `PATCH /api/recipes/[id]/photo` |
| `Store/save/seed/boot IIFE` (1080–1150, 6103–6570) | **Replaced** by Prisma + `prisma/seed.ts` (final state) |
| Nav/render/route/modal/toast (1520–1760) | `components/layout`, `components/shared` |
| `vPrep, prepPrint, prepCsv` (1758–1920) | `app/production/prep`, print route |
| `vPlan, planCsv, setMenuPrice` (1923–2050) | `app/menu-plans` (SSEM) |
| `vProd, vReq, prodPrint*, prodCsv, reqCsv, applyMenuDay` (2051–2560) | `app/production`, `domain/production`, print/CSV route handlers |
| `vBrands` (2564), Settings brand mgmt (4118–4280) | `app/brands`, `app/settings` |
| `vDash` (2614) | `app/dashboard` (Server Component; metrics in `domain/dashboard`) |
| `vRecipes, vEdit, vLocked, newRecipe, nextCode, dup, delete, lock/unlock, bulk*` (2752–3730) | `app/recipes`, `/api/recipes/**`, `domain/recipes` |
| `vItems, saveItem, delItem, item importer` (3730–3860, 4660–4830) | `app/ingredients`, `/api/ingredients/**`, import route |
| `vConv, saveConv` (3887–4064) | `app/conversions` |
| `vYields` (4068) | `app/yields` (static `YIELD_REF`) |
| `vSettings` (4085) | `app/settings` (`PATCH /api/settings`) |
| `vHealth` (4318) | `app/health` (+ `/api/health`) |
| `vBackup, exportAll, doRestore, doReset, CSV exports` (4371–4600) | `app/backup`, export/import route handlers (reset/rebuild not ported) |
| XLSX writer/reader, recipe import/export (4852–5430, 5528–5840) | `src/lib/xlsx/*`, `/api/recipes/import|export` |
| `printCard, buildCardHTML, cardDocument` (5860–6100) | `components/recipes/RecipeCard` + `styles/print.css` |
