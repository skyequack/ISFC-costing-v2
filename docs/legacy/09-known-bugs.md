# Legacy known bugs / quirks and the decision for each
| # | Legacy behavior | Decision |
|---|---|---|
| 1 | `prodCsv` (2548) throws ReferenceError (`sites` undefined) | Implement intended CSV (D-19) |
| 2 | `doBulkLock` (3066) throws at 3074 (`trash` null) — locks never saved | Implement intended behavior (D-18) |
| 3 | `bulkUnlock` skips the PIN gate single unlock honours | Moot (PIN removed); `recipe.unlock` enforced |
| 4 | `prodLoc` sentinel `''` (Prep "All sites") vs `'*'` (Production); `pQty('')` returns only the unassigned bucket | Single "all sites = sum" semantic (D-20) |
| 5 | Pax keyed by menu array index; unsited `|mi` bucket not summed with sited | Stable `menuId`; all-sites sum (D-05/D-20) |
| 6 | Import/export drop `yp` and `buffer`; export/print show `y*100` not `yp` | Add columns (D-17); print y column unchanged |
| 7 | Print "Variable buffer" label uses global buffer, amount uses real | Label = effective rate (D-21) |
| 8 | Import: same code under two brands → duplicates; collision moves card across brands | Reject duplicates; brand change needs both brands (D-12) |
| 9 | Editor allows duplicate/self-referencing codes; cycles only caught at cost time | Block (D-12, D-13) |
| 10 | Deleted seed items reappear each load (no tombstones); `deletedCards` never shrinks on undo | Boot integrity pass not ported; soft delete (D-08, D-14) |
| 11 | Restore of a standard backup wipes `security`; restore doesn't run migrations | N/A (security removed); restore validated + transactional |
| 12 | Audit details HTML-escaped at write (`setMenuPrice`, item import) then escaped at display; cap 600 only through `logit`; `Signed in/out` flood | Plain text, no cap, no sign-in entries (D-15) |
| 13 | Brand add/edit, settings % edits, `export` perm unguarded server-side; `brands.edit` only on delete | Server guards (D-16, D-23) |
| 14 | `saveItem` rebuilds object (drops unknown fields), accepts negative price; delete leaves orphan `conv` | Validate; delete conversion with item |
| 15 | Dashboard averages unweighted, all brands, "Locked" counts subs | Keep formula; brand-scope; excluded count note (D-30) |
| 16 | Month average divides by calendar days; day select can exceed month length | Keep average definition; clamp day |
| 17 | Requisition ignores conv/yp/buffer; gram qty priced at per-kg (≈1000×); depth>4 silently dropped | Conversion-aware valuation + flags + reconciliation (D-10/D-28) |
| 18 | `reqExpand` treats any recipe code (even menu type) as sub; case-insensitive; dashboard "Used in" is case-sensitive | Preserve reqExpand semantics; document |
| 19 | `applyMenuDay` overwrites demanded codes only, never clears stale ones; item-kind cells dropped | Preserve; surface unmatched dishes |
| 20 | `setYieldPct` double guard (`settings.edit` && `recipe.edit`) can toast wrong error; shim edits line/card/setting | Separate explicit endpoints per field |
| 21 | Latent: setters not calling `editable()` (setYieldPct, applyCode, pick, commitCode, addFromBrowse, regenCode) | Server rejects all edits to locked cards |
| 22 | Health needConv message says "costed as if units matched" but cost is 0 | Correct wording |
| 23 | Print audit logged even when print cancelled | Keep (audit "sent"), document |
| 24 | Settings % accept negative / >100 | Range-validate (reject nonsense) — mention in UI error |
| 25 | `Restored a General Manager account` / `resetAccess` from login screen | Removed |
