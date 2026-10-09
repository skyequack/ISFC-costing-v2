# Legacy behavior 02 — Costing engine and requisition math (business-critical)
Source lines: `legacy/app.html` 1362–1480 (cost engine), 2093–2260 (requisition/production), 1640–1740 (plan). **Port line-for-line into pure TypeScript (`src/domain/costing`), then prove equality with `golden/costs.json`.** Numbers are JS doubles → use `number`/Postgres `double precision`; never Decimal; never round before summing.

## 1. Helpers
`num(v)` = `parseFloat(v)`, `0` if not finite (1486). `ITEM[code]` and `RCP[code]` are indexes built by `reindex()` (1355): items by exact code; recipes by exact code with **last card winning** on duplicates.

## 2. `resolve(code, seen)` (1375)
1. If `ITEM[code]`: `{name,uom,price: it.price==null?0:it.price, kind:'item', err: it.price==null?'no price':''}`.
2. Else if `RCP[code]` and `type==='sub'`: `s=subUnitCost(r,seen)` → `{name, uom: r.subUom||'Gram', price:s.v, kind:'sub', err:s.err}`.
3. Else if `RCP[code]` (menu type): `{kind:'menu', price:0, err:'not a sub-recipe'}`.
4. Else `{name:'CODE NOT FOUND', price:0, kind:'none', err:'unknown code'}`.
Items always win over recipes (namespaces must therefore never collide — enforced by D-33/schema).

## 3. `subUnitCost(rec, seen)` (1362)
`seen = seen||new Set()`; if `seen.has(rec.code)` → `{v:0, err:'circular'}`; add code; `c=batch(rec,seen)`; `q = num(rec.batchOut) || num(rec.subQty) || 0`; if `!q` → `{v:0,err:'no batch output'}`; return `{v: c.total/q, err: c.err}`. **Raw unit cost — NO buffer** (buffer applies once, in `_cost`; applying it per nesting level compounded 1.10² = 21%).

## 4. `lineCost(l, seen)` (1389)
`r = resolve(l.code, seen)`; `qty=num(l.qty)`; `yRaw=num(l.y)`; **`y = (yRaw>0 && yRaw<=10) ? yRaw : 1`**.
Unit conversion: `lu = lowercase-trim(l.unit)`, `pu = lowercase-trim(r.uom)`. If `lu && pu && lu!==pu`: `f=S.conv[l.code]` (= `[unit, factor]`), `fu = lowercase-trim(f[0])`; if `f && num(f[1]) && fu===lu` → `q = qty/num(f[1]); conv=true`; else `needConv=true` (q stays `qty`).
`gross = y ? q/y : q`; **`cost = needConv ? 0 : gross * r.price`**. Returns `{...r, qty,q,gross,cost,conv,needConv,y}`.
Semantics: `S.conv[code]=[recipeUnit, recipeUnitsPerPurchaseUnit]`; **dividing is always correct** provided the stored unit equals the line's unit; otherwise the line costs **0** and is flagged (never multiply, never invert).

## 5. `batch(rec, seen)` (1418)
For each `l` of `rec.lines`: skip if `!l.code`; `c=lineCost(l, seen?new Set(seen):undefined)` (**fresh copy of `seen` per line**); `total+=c.cost`; push `{line:l,cost:c.cost}` to `rows`; `err`: if `c.needConv` → `'missing unit conversion'` (always wins) else if `c.err && !err` → `c.err`. Returns `{total, err, rows}`.

## 6. `_cost(rec)` (1444) and `cost(rec)` (1438)
`cost` memoizes by `rec.id` in `_cc` (cleared by `bustCost()`); the new engine is a pure function with no cache (cache at the data-loader level instead).
```
st = settings; b = batch(rec)
out  = max(1, num(rec.output) || 1)
orig = b.total / out
buf  = (rec.buffer != null) ? num(rec.buffer) : num(st.buffer)
yielded = Σ over b.rows:  p = (line.yp != null) ? num(line.yp)/100 : buf ;  num(row.cost) * (1 + p)
food = (yielded || orig*(1+buf)) / out
sp   = num(rec.price)
pkg = sp*num(st.pkg); del = sp*num(st.del); lab = sp*num(st.lab); ops = sp*num(st.ops)
totalCost = food + pkg + del + lab + ops
net = sp - totalCost
g/ml/ea: Σ num(l.qty) for lines with code, bucketed by lowercase unit 'gram' | 'ml' | else(each)
autoOut = g||ml||ea ; autoUom = g?'Gram': ml?'Ml':'Each'
manual = num(rec.batchOut) ; bOut = manual||autoOut ; bUom = manual ? (rec.batchUom||autoUom) : autoUom
return {
  batch:b.total, err:b.err, out, orig, food, pkg, del, lab, ops, totalCost, net, sp,
  fcPct: sp ? food/sp : null, tcPct: sp ? totalCost/sp : null, npPct: sp ? net/sp : null,
  gramTotal:g, mlTotal:ml, eaTotal:ea, autoOut, autoUom, bOut, bUom, manualOut:!!manual,
  portion: out ? bOut/out : 0, weight: g/out,
  suggest: num(st.target) ? food/num(st.target) : 0,        // "Price at target"
  vatPrice: sp*(1+num(st.vat)),
  unitCost: rec.type==='sub' ? subUnitCost(rec).v : null }
```
Important quirks to preserve: `yp` is a **percent** (15 = 15%); `yp=0` ≠ `yp=null` (null falls back to card buffer then settings.buffer); `y` is a divisor; both can be set (double waste — warn only, D-41); `food` falls back to `orig*(1+buf)` only when `yielded` is exactly 0; overhead charges are percentages of **selling price** (so a card with `sp=0` shows 0 overheads); food-cost % = food/sp, ex-VAT.
Golden facts: 321 cards all `err=''`; **320 of 321 have `sp=0`**; only `GRM-MN-0001` has a price (108 → food 29.63, fc 27.4%, net 24.37, suggest 98.76). The golden alone does NOT exercise the percentage loads → Phase 2 must add synthetic priced cases (see docs/TESTING.md).

## 7. Requisition / production expansion — `reqExpand(r, portions, acc, depth)` (2093)
**Separate algorithm; do not unify with costing.** Rules (legacy):
1. Return if `depth>4` (silent truncation → we now flag) or `r` null.
2. `out = max(1, num(r.output)||1)`.
3. Per line: `y = num(l.y) || 1` (**no clamp to ≤10**); `q = (num(l.qty)/out) * portions / y`.
4. `sub` = any recipe whose code equals `l.code` case-insensitively (**any type**, not only `sub`); if found → recurse with `q` as the new `portions` (line qty treated as sub-recipe portions), `depth+1`.
5. Else `ITEM[l.code]`; if missing → `acc['?'+code] = {name:'(not in library)', uom:'', qty+=q, cost:0, from:{}}`.
6. Else `acc[code]` accumulate `qty+=q; cost += q*num(it.price); from[r.name]+=q`.
Legacy ignores `S.conv`, `yp` and buffer here, so requisition value ≠ portions × card cost, and gram quantities are priced at per-kg prices (up to ~1000× error). **Decision D-10/D-28:** keep quantity semantics, but valuation applies the same conversion as `lineCost`, flags unconvertible lines and depth truncation, and a reconciliation report compares requisition value with Σ(portions × `cost(card).food`) and explains variance (buffer/yp). Label the value "issue value, excl. waste buffer".
Displays: quantities `cur(qty,1)` in vReq, 2dp in Prep, 0dp in printed sheets (a 0.4 draw prints "0" — preserved); sorts: cost desc (Prep, Req consolidated), qty desc (`prodDrawSummary`), name asc (sheets).

## 8. Plan costing — `planCost` (1693)
Cell cost = card `cost(r).food` for kind `card`, or library item `price` for kind `item` (price 0/null = unpriced → falls back to fuzzy card match "new card"). Unpriced cells count as 0, so day/week totals are a floor (`planDay` counts priced vs unpriced; `planWeek` sums days). `setMenuPrice` (1644) rounds to 6dp, clears a "PRICE MISSING" flag, `guard('items.edit')`, audit "Priced a menu item from the menu plan".
`planFindCard(name)` (1672): first `PLAN_ALIAS` (name → SSEM code), then fuzzy tokens (lowercase; strip trailing "s" on words >3 chars; drop stop words or/with/and/the/of/a/portions/portion/same; need ≥2 shared tokens; score = 1+inter/100 if card tokens ⊂ cell tokens; 0.95 if cell tokens ⊂ card tokens and card has ≤1 extra token; else Jaccard ≥ 0.7). Cache `_pcCache` invalidated when `S.recipes.length` changes. `planFamily` = first token of menu name uppercased (defined twice, identical).

## 9. Cycle handling
Legacy: only `subUnitCost` detects cycles at cost time (`circular`, cost 0); the editor does not prevent them and allows self-reference and menu-type codes. Requisition recursion is bounded only by depth 4. **New (D-13):** editor/API/import block cycle-creating saves (DFS over all SUB recipes' line codes, case-insensitive code match, inside the save transaction under an advisory lock); the cost engine keeps `circular` as a safety net.

## 10. Dashboard formulas (`vDash`, 2614) — see 05-screens-dashboard-brands-health.md
