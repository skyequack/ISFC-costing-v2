# Legacy behavior 01 — State, seed, boot, persistence
Source: `legacy/app.html` (frozen copy of ISFC_Costing_System_v8.7.html, 6,574 lines; build marker `BUILD_N=85`/"v8.5"). Line numbers refer to that file. Facts below were measured by booting the legacy app in jsdom with empty storage (`tools/dump-golden.js` → `golden/state.json`) and by reading the code. **Re-verify against the cited lines before relying on any detail** — but do not depend on any chat/session history.

## 1. The `S` object (global state, one JSON blob)
Persisted under key `isfc_costing_v1` (line 997) via `Store` (1080–1090): `window.storage` first (Claude-artifact storage, value wrapped in `{value}`), else `localStorage`. `save()` (1147) = `bustCost()` + `Store.set(S)`; failure shows "SAVE FAILED - export a backup". No debounce, no cross-tab conflict handling (last write wins). `CUR` (signed-in user) is in-memory only.

| Field | Shape |
|---|---|
| `settings` | `{currency:'SAR', pkg:.10, del:.10, lab:.25, ops:.05, buffer:.15, target:.30, vat:.15, priceDate:'YYYY-MM-DD'}` — all percentages are **fractions** |
| `items[]` | `{code,name,uom,price,cat,sub,flag,brands?}` — `price` may be `null`; `uom` ∈ Gram/Ml/Each/Slice; `flag` free text; `brands` optional array of brand ids (missing/empty = **Shared**) |
| `conv{}` | `{ [itemCode]: [recipeUnit, recipeUnitsPerPurchaseUnit] }` e.g. `"BKR1-3695":["Gram",60]` |
| `recipes[]` | see 03-recipes.md |
| `brands[]` | `{id,name,code,color,logo(base64),ink?,nameAr?,locs?[]}` |
| `users[]` | `{id,name,role,pin,active?}` — **not migrated** (Clerk replaces) |
| `security` | `{salt,hash,requireUnlock,requireDelete,requireSettings,sessionMins,manager}` — **removed** |
| `audit[]` | `{t:epochMs,u:name,r:roleKey,a:action,d:detail}` newest first |
| `seq` | counter for `uid()` = `'R'+(seq++).toString(36).toUpperCase()+Date.now().toString(36).slice(-3)` |
| `activeBrand` | brand id or `''` — a UI workspace filter, **not** access control |
| lazy | `production{ 'YYYY-MM':{ 'DD':{ 'LOC|CODE' or 'CODE': portions }}}` (2060); `menuPax{ month:{day:{'LOC|menuIndex': people}}}` (2215); `deletedCards[]` (uppercased codes) |
| markers | `masterRev, methodRev, dedupeRev, ssemPxRev, extraRev, recipeRev, menuScopeRev, yieldRev, ncPxRev, ncBuildRev, yield15Rev, buildN, fileSnap` (boot-migration bookkeeping — not migrated) |

Item notes: 135 of 1046 items have `price:null` (flag "PRICE MISSING"); 161 carry a `flag`; 320 are brand-scoped (bssem 157, bnc 154, b7 9). `iCode(v)` = trim + collapse whitespace + uppercase (used by importers/boot). Items screen edit/delete use exact `===`.
Brand notes: ids `bnc, b1…b12, bssem`; `locs` only on `bssem` (`['NIC','NEOM','JUBAIL','YANBU']`, `DEF_LOCS` 2049); `ink` only Salus (`#141414`); `nameAr` only `bnc` and `b10`.
User notes: PINs plaintext 4–8 digits (viewer may be empty); default GM id `u1` PIN `1234` shown on login screen.

## 2. Seed constants (all extracted to `prisma/seed-data/`)
`SEED_ITEMS` (1046, line 483) · `MASTER_PATCH` (27, 494; all already in SEED_ITEMS) · `RECIPE_PATCH` (319 cards, 504: bnc 234, b7 12, no brandId 73 → bssem) · `DEMO_RECIPES` (2 GRM cards, 998) · `SEED_CONV` (34, 542) · `DEF_BRANDS` (13, 1106) + `SSEM_BRAND` (503) · `DEF_SETTINGS` (1093) · `DEF_USERS` (577) · `DEF_SEC` (1122) · `ROLES` (552) · `YIELD_REF` (43 rows, 544) · `MENU_PLAN` (8 menus, line 1045) · `SEED_ISSUES` (27) · `DEF_LOCS` · `SECTIONS` · `PLAN_ALIAS` (11). Empty: `EXTRA_ITEMS`, `LINE_FIX`.

## 3. Boot sequence (6103–6570) and why we do NOT port it
Boot: load saved state or `seed()` (1131: settings, users, audit[], brands, activeBrand 'b1', items, masterRev, conv, seq 3, DEMO_RECIPES). Then ~20 migrations, each gated by a rev marker (run once per browser) except the **integrity pass, which runs on every load** (re-adds deleted seed items — items have no tombstones — and re-adds RECIPE_PATCH cards not in `deletedCards`). Notable destructive ones: `ncBuildRev` deletes all `bnc`-scoped items and `bnc` recipes then re-adds from file; `yieldRev` sets every line `y=1` and settings.buffer 0.20; `yield15Rev` sets every card buffer 0.15 and settings.buffer 0.15; `ncPxRev` reprices NC items; `menuScopeRev` scopes `MNU-*` items to `bssem`; `dedupeRev` remaps recipe lines for 5 duplicate-code pairs. Brand fix-ups (colour/logo backfill, drop duplicate brand codes, add SOL) run on every load.
**Decision D-08:** migrate the **final effective state** = `golden/state.json` (1046 items, 321 recipes [2 GRM demo, 73 SSEM, 12 SMC, 234 NC], 14 brands, 34 conv; all recipes `draft`; all lines `y=1`; `yp=15` on 7305 of 7321 lines; every card `buffer=0.15`; no photos). Recipe ids are non-deterministic (`uid()`), so **key on `code`**. Order after boot: GRM demo cards, SSEM, SMC, NC.
5 audit entries exist in golden (system messages); they are artifacts and are not migrated as audit rows (optionally seeded as `SEED` audit entries).

## 4. Other persistence paths
`exportAll(false)` = JSON of `S` without `users`/`security`; `exportAll(true)` includes plaintext PINs. `doRestore` (4463): needs `data.admin`, only validates JSON has `items` and `recipes`, full replace (settings merged over defaults), a standard backup wipes `security`; migrations don't re-run until reload. `doReset` = `S=seed()` keeping users/audit. `doRebuild` deletes storage key and reloads. `resetAccess` (758) resets GM to PIN 1234 from the login screen — **removed**.

## 5. Regenerating the oracle
```
cd tools && npm i && node dump-golden.js   # legacy boot -> golden/state.json
node dump-costs.js                          # legacy cost() over every golden recipe -> golden/costs.json
node extract-assets.js                      # logos -> public/assets/*.png
node extract-seed.js                        # golden + constants -> prisma/seed-data/*.json
```
`golden/` and `legacy/` are read-only oracles; never edit by hand.
