'use client';

import { useRouter } from '@/components/shell/nav-progress';
import { useCallback } from 'react';
import { api, errText } from '@/components/shared/api-client';
import { createStore, useStore, type Store } from '@/components/shared/form-store';
import { useModal } from '@/components/shared/Modal';
import { useSession } from '@/components/shared/session-context';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { cur } from '@/lib/format';
import { blockTplRows, parseRecipeSheets, RTPL_HEAD, recipeTplRows, type ImportCard } from '@/lib/import/recipes';
import { readSheets } from '@/lib/xlsx/read';
import type { RecipeImportIn, RecipeImportPlan } from '@/lib/services/import-recipes';
import { RECIPE_PART_CARDS, RECIPE_PART_LINES } from '@/lib/io-limits';
import { readFileBytes, saveCsv, saveXlsx } from './download';

const PART_CARDS = RECIPE_PART_CARDS;
const PART_LINES = RECIPE_PART_LINES;

interface ExportFile {
  filename: string;
  rows: unknown[][];
}

/** Recipe upload / export / templates (legacy importRecipes 5448, recipeTemplateMenu 5365, dlRecipeTpl 5432, doImportRecipes 5528). */
export function useRecipeIO() {
  const modal = useModal();
  const toast = useToast();
  const router = useRouter();
  const { workspace, brands } = useSession();

  const fetchExport = useCallback(
    async (brand: string): Promise<ExportFile> =>
      api('GET', `/api/export/recipes-data?brand=${encodeURIComponent(brand)}`),
    [],
  );

  const exportAll = useCallback(
    async (fmt: 'xlsx' | 'csv', brand = '*') => {
      try {
        const f = await fetchExport(brand);
        const base = f.filename.replace(/\.xlsx$/, '');
        if (fmt === 'csv') saveCsv(`${base}.csv`, f.rows);
        else saveXlsx(`${base}.xlsx`, f.rows);
        toast(`Downloaded ${base}.${fmt}`);
      } catch (e) {
        toast(errText(e));
      }
    },
    [fetchExport, toast],
  );

  const templateMenu = useCallback(() => {
    const act = workspace;
    const blank = (fmt: 'xlsx' | 'csv') => {
      const rows = [
        RTPL_HEAD,
        ...recipeTplRows(act?.code ?? 'FRS', brands.find((b) => b.id !== act?.id)?.code ?? act?.code ?? 'GRM'),
      ];
      const base = `ISFC-${act?.code || 'recipe'}-recipe-template`;
      if (fmt === 'csv') saveCsv(`${base}.csv`, rows);
      else saveXlsx(`${base}.xlsx`, rows);
      toast(`Downloaded ${base}.${fmt}`);
    };
    modal.open({
      title: 'Recipe upload template',
      body: (
        <>
          <p style={s('font-size:13px;color:var(--mute);margin-bottom:14px')}>
            One row per ingredient line. Repeat the <b>Recipe Code</b> down the rows of the same card, or leave it blank{' '}
            {'–'} the rows are read in order. The <b>Brand</b> column lets a single sheet carry every brand at once.
          </p>
          <div style={s('display:flex;flex-direction:column;gap:9px')}>
            <button
              className="btn g"
              style={s('justify-content:center')}
              onClick={() => {
                saveXlsx('ISFC-recipe-card-template.xlsx', blockTplRows(15));
                toast('Downloaded ISFC-recipe-card-template.xlsx');
              }}
            >
              {'⤓'} Recipe card template (Excel) {'–'} your own layout
            </button>
            <button className="btn" style={s('justify-content:center')} onClick={() => blank('xlsx')}>
              Blank template with examples (Excel)
            </button>
            <button className="btn o" style={s('justify-content:center')} onClick={() => blank('csv')}>
              Blank template with examples (CSV)
            </button>
            {act && (
              <button className="btn o" style={s('justify-content:center')} onClick={() => exportAll('xlsx', act.id)}>
                {act.name} {'–'} export the {act.cards} existing card{act.cards === 1 ? '' : 's'} to edit
              </button>
            )}
            <button className="btn o" style={s('justify-content:center')} onClick={() => exportAll('xlsx', '*')}>
              All brands {'–'} every card in the system to edit
            </button>
          </div>
          <div className="note" style={s('margin:16px 0 0')}>
            <b>Prices.</b> There is no ingredient price column and there never will be. Every line is costed from the
            Ingredient Library, so a recipe upload cannot change what anything costs.
          </div>
        </>
      ),
    });
  }, [brands, exportAll, modal, toast, workspace]);

  const upload = useCallback(() => {
    const st = createStore({
      brandId: workspace?.id ?? brands[0]?.id ?? '',
      takePrice: false,
      allowUpdate: true,
      grant: true,
    });

    function back(message: string, title = 'Could not read that file') {
      modal.open({
        title,
        body: <div className="note r">{message}</div>,
        foot: (
          <button className="btn o" onClick={upload}>
            Back
          </button>
        ),
      });
    }

    async function pickFile(file: File | undefined) {
      if (!file) return;
      const o = st.get();
      modal.open({
        title: 'Reading the file',
        body: (
          <p style={s('font-size:13.5px')}>
            Opening <b>{file.name}</b> {'…'}
          </p>
        ),
        foot: <></>,
      });
      let parsed: ReturnType<typeof parseRecipeSheets>;
      try {
        parsed = parseRecipeSheets(await readSheets({ name: file.name, bytes: await readFileBytes(file) }));
      } catch (e) {
        return back(e instanceof Error ? e.message : 'Unreadable file.');
      }
      if (parsed.empty)
        return back(
          'Nothing usable was found in ' +
            file.name +
            '. A card sheet needs a line table with Code and Item headings, or use the flat template.',
          'Nothing to load',
        );
      try {
        const parts: ImportCard[][] = [];
        let cur: ImportCard[] = [];
        let lines = 0;
        for (const c of parsed.cards) {
          if (cur.length && (cur.length >= PART_CARDS || lines + c.lines.length > PART_LINES)) {
            parts.push(cur);
            cur = [];
            lines = 0;
          }
          cur.push(c);
          lines += c.lines.length;
        }
        if (cur.length) parts.push(cur);
        const base = {
          defaultBrandId: o.brandId,
          takePrice: o.takePrice,
          allowUpdate: o.allowUpdate,
          grant: o.grant,
          file: file.name,
        };
        const plans: RecipeImportPlan[] = [];
        for (const part of parts)
          plans.push(await api<RecipeImportPlan>('POST', '/api/recipes/import?mode=dry-run', { ...base, cards: part }));
        review(file.name, parsed, parts, plans, base);
      } catch (e) {
        back(errText(e));
      }
    }

    function review(
      file: string,
      parsed: ReturnType<typeof parseRecipeSheets>,
      parts: ImportCard[][],
      plans: RecipeImportPlan[],
      base: Omit<RecipeImportIn, 'cards' | 'hash'>,
    ) {
      const cards = plans.flatMap((p) => p.cards);
      const sum = (k: keyof RecipeImportPlan['counts']) => plans.reduce((a, p) => a + p.counts[k], 0);
      const nAdd = sum('add');
      const nUpd = sum('update');
      const nSkip = sum('locked') + sum('exists') + sum('nolines');
      const nBlocked = sum('blocked');
      const perBrand: RecipeImportPlan['perBrand'] = {};
      for (const p of plans)
        for (const [id, x] of Object.entries(p.perBrand)) {
          const t = (perBrand[id] ||= { ...x, add: 0, upd: 0, lines: 0 });
          t.add += x.add;
          t.upd += x.upd;
          t.lines += x.lines;
        }
      const defName = brands.find((b) => b.id === base.defaultBrandId)?.name ?? '';
      const badBrand: Record<string, number> = {};
      cards.forEach((c) => c.badBrand && (badBrand[c.badBrand] = (badBrand[c.badBrand] ?? 0) + 1));
      const nGrant = plans.reduce((a, p) => a + p.needGrant, 0);
      const unknown = [...new Set(cards.flatMap((c) => c.unknown))];
      const nConv = cards.reduce((a, c) => a + c.conv.length, 0);
      const convWarn = cards.flatMap((c) => c.conv).slice(0, 12);
      const nPkg = cards.reduce((a, c) => a + c.pkgLines, 0);
      const nNoPrice = cards.reduce((a, c) => a + c.noPrice, 0);
      const noPrice = [...new Set(cards.flatMap((c) => c.noPriceCodes))];
      const blocked = cards.filter((c) => c.action === 'blocked');
      const nLines = Object.values(perBrand).reduce((a, x) => a + x.lines, 0);
      const blk = parsed.blocks;

      async function commit() {
        try {
          let added = 0;
          let updated = 0;
          let granted = 0;
          const hit = new Set<string>();
          for (let i = 0; i < parts.length; i++) {
            const r = await api<{ added: number; updated: number; granted: number; brands: string[] }>(
              'POST',
              '/api/recipes/import?mode=commit',
              {
                ...base,
                cards: parts[i],
                file: file + (parts.length > 1 ? ` (part ${i + 1}/${parts.length})` : ''),
                hash: plans[i]!.hash,
              },
            );
            added += r.added;
            updated += r.updated;
            granted += r.granted;
            r.brands.forEach((b) => hit.add(b));
          }
          finished(added, updated, granted, [...hit]);
        } catch (e) {
          toast(errText(e));
        }
      }
      function finished(added: number, updated: number, granted: number, hit: string[]) {
        router.refresh();
        modal.open({
          title: 'Upload finished',
          body: (
            <>
              <div className="row r2" style={s('margin-bottom:14px')}>
                <div className="kpi g" style={s('border-top-width:3px')}>
                  <div className="k">Cards added</div>
                  <div className="v">{added}</div>
                </div>
                <div className="kpi" style={s('border-top-width:3px')}>
                  <div className="k">Cards updated</div>
                  <div className="v">{updated}</div>
                </div>
              </div>
              <p style={s('font-size:13px')}>
                Loaded into <b>{hit.length === 1 ? hit[0] : `${hit.length} brands`}</b> ({hit.join(' ')}) and costed
                against the existing ingredient library. No purchase price was changed.
                {granted
                  ? ` ${granted} ingredient${granted === 1 ? ' was' : 's were'} also made visible to the brands that use them.`
                  : ''}
              </p>
              <div className="note" style={s('margin-top:12px')}>
                Run <b>Data Health</b> next {'–'} it lists any card whose cost is incomplete because of an unknown code
                or a missing unit conversion.
              </div>
            </>
          ),
          foot: (
            <>
              <button className="btn o" onClick={() => (modal.close(), router.push('/health'))}>
                Data Health
              </button>
              <button className="btn" onClick={() => (modal.close(), router.push('/recipes'))}>
                View the cards
              </button>
            </>
          ),
        });
      }

      modal.open({
        title: 'Check before loading',
        body: (
          <>
            <div className="row r3" style={s('margin-bottom:14px')}>
              <div className="kpi g" style={s('border-top-width:3px')}>
                <div className="k">New cards</div>
                <div className="v">{nAdd}</div>
              </div>
              <div className="kpi" style={s('border-top-width:3px')}>
                <div className="k">Updated</div>
                <div className="v">{nUpd}</div>
              </div>
              <div className={`kpi ${nSkip ? 'w' : ''}`} style={s('border-top-width:3px')}>
                <div className="k">Skipped</div>
                <div className="v">{nSkip}</div>
              </div>
            </div>
            <p style={s('font-size:13px;margin-bottom:12px')}>
              <b>{file}</b> {'·'} {cards.length} card{cards.length === 1 ? '' : 's'} read {'·'} {nLines} ingredient
              lines {'·'} {Object.keys(perBrand).length} brand
              {Object.keys(perBrand).length === 1 ? '' : 's'}.
            </p>
            {nBlocked > 0 && (
              <div className="note r" style={s('margin:0 0 10px')}>
                <b>
                  {nBlocked} card{nBlocked === 1 ? '' : 's'} cannot be loaded
                </b>{' '}
                {'–'} fix the file and check it again. Nothing is written until every card in the file can be loaded.
                <div style={s('margin-top:5px;font-size:11.5px;max-height:130px;overflow:auto')}>
                  {blocked.slice(0, 15).map((c, i) => (
                    <div key={i}>
                      <b>{c.code || c.name || `card ${c.index + 1}`}</b>: {c.reason}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {Object.keys(perBrand).length > 0 && (
              <div className="tw" style={s('margin-bottom:12px')}>
                <table>
                  <thead>
                    <tr>
                      <th>Brand</th>
                      <th className="c" style={s('width:70px')}>
                        New
                      </th>
                      <th className="c" style={s('width:80px')}>
                        Updated
                      </th>
                      <th className="c" style={s('width:70px')}>
                        Lines
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(perBrand).map(([id, x]) => (
                      <tr key={id}>
                        <td>
                          <b>{x.name}</b>{' '}
                          <span className="mono" style={s('color:var(--mute)')}>
                            {x.code}
                          </span>
                        </td>
                        <td className="c">{x.add}</td>
                        <td className="c">{x.upd}</td>
                        <td className="c">{x.lines}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!parsed.hasBrandColumn && (
              <div className="note" style={s('margin:0 0 10px')}>
                No <b>Brand</b> column in this sheet {'–'} every card goes to <b>{defName}</b>. Add the column to split
                one file across brands.
              </div>
            )}
            {Object.keys(badBrand).length > 0 && (
              <div className="note r" style={s('margin:0 0 10px')}>
                <b>Brand not recognised</b> on {Object.values(badBrand).reduce((a, c) => a + c, 0)} row(s) {'–'} sent to{' '}
                <b>{defName}</b> instead.
                <div className="mono" style={s('margin-top:5px;font-size:11px')}>
                  {Object.keys(badBrand).slice(0, 10).join(', ')}
                </div>
              </div>
            )}
            {nGrant > 0 && (
              <div className="note" style={s('margin:0 0 10px')}>
                {nGrant} ingredient/brand pair{nGrant === 1 ? '' : 's'}{' '}
                {base.grant ? 'will be opened up' : 'stay restricted'} so the brand can see the item in its own picker.
                Costing is unaffected either way.
              </div>
            )}
            <div className="note" style={s('margin:0 0 12px')}>
              <b>Nothing in this file affects cost.</b> The upload takes the output, the item codes and the quantities.
              Every ingredient is priced from the Ingredient Library at the moment of costing, so any PPG, Total or Net
              cost column in the sheet is read past. Change a purchase price in the library and every card that uses it
              re-costs itself.
              <br />
              Selling price: <b>{base.takePrice ? 'read from the file' : 'left as it is on the system'}</b>.
            </div>
            {sum('locked') > 0 && (
              <div className="note" style={s('margin:0 0 10px')}>
                {sum('locked')} card{sum('locked') === 1 ? ' is' : 's are'} approved and locked {'–'} left untouched.
              </div>
            )}
            {sum('exists') > 0 && (
              <div className="note" style={s('margin:0 0 10px')}>
                {sum('exists')} card{sum('exists') === 1 ? '' : 's'} already exist and overwriting is switched off.
              </div>
            )}
            {sum('nolines') > 0 && (
              <div className="note" style={s('margin:0 0 10px')}>
                {sum('nolines')} card{sum('nolines') === 1 ? '' : 's'} had no valid ingredient line and cannot be
                costed.
              </div>
            )}
            {unknown.length > 0 && (
              <div className="note r" style={s('margin:0 0 10px')}>
                <b>
                  {unknown.length} unknown or unavailable item code{unknown.length === 1 ? '' : 's'}
                </b>{' '}
                {'–'} add them to the Ingredient Library (or get access to them) before loading.
                <div className="mono" style={s('margin-top:5px;font-size:11px;max-height:110px;overflow:auto')}>
                  {unknown.slice(0, 20).join(' · ')}
                </div>
              </div>
            )}
            {nConv > 0 && (
              <div className="note" style={s('margin:0 0 10px')}>
                <b>
                  {nConv} line{nConv === 1 ? '' : 's'} need a unit conversion
                </b>{' '}
                {'–'} add them on the Unit Conversions screen or the cost stays zero.
                <div className="mono" style={s('margin-top:5px;font-size:11px;max-height:110px;overflow:auto')}>
                  {convWarn.map((x, i) => (
                    <div key={i}>{x}</div>
                  ))}
                  {nConv > convWarn.length && <div>{'…'}</div>}
                </div>
              </div>
            )}
            {parsed.warn.length > 0 && (
              <div className="note" style={s('margin:0 0 10px')}>
                <b>
                  {parsed.warn.length} row{parsed.warn.length === 1 ? '' : 's'} ignored
                </b>
                <div style={s('margin-top:5px;font-size:11.5px;max-height:110px;overflow:auto')}>
                  {parsed.warn.slice(0, 15).map((x, i) => (
                    <div key={i}>{x}</div>
                  ))}
                  {parsed.warn.length > 15 && <div>{'…'}</div>}
                </div>
              </div>
            )}
            {blk.length > 0 && (
              <div className="note" style={s('margin:0 0 10px')}>
                <b>
                  {blk.length} card sheet{blk.length === 1 ? '' : 's'} read in the kitchen&apos;s own layout.
                </b>{' '}
                Item codes, quantities and units came from each line table, and the number of portions from the stacked
                figures at the top. The cost figures on those sheets were not read.
                {blk.some((m) => m.dishwt != null) && (
                  <>
                    <br />
                    <b>Weight of dish</b> was noted but not imported {'–'} the app works out portion size from the line
                    quantities.
                  </>
                )}
                {blk.some((m) => m.notes.length) && (
                  <div style={s('margin-top:6px;font-size:11.5px;max-height:96px;overflow:auto')}>
                    {blk
                      .filter((m) => m.notes.length)
                      .slice(0, 8)
                      .map((m, i) => (
                        <div key={i}>
                          <b>{m.name}</b>: {m.notes.slice(0, 3).join('; ')}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}
            {nPkg > 0 && (
              <div className="note r" style={s('margin:0 0 10px')}>
                <b>
                  {nPkg} packaging line{nPkg === 1 ? '' : 's'} sit inside the ingredient lists.
                </b>{' '}
                This system also adds Packaging as a percentage of the selling price in Cost Settings, so counting it in
                both places doubles it. Either drop those lines or set that percentage to zero.
              </div>
            )}
            {nNoPrice > 0 && (
              <div className="note r" style={s('margin:0 0 10px')}>
                <b>
                  {nNoPrice} line{nNoPrice === 1 ? '' : 's'} point at an ingredient with no purchase price.
                </b>{' '}
                Those lines will cost zero, which quietly understates the card rather than failing. Put the price into
                the Ingredient Library and the cards correct themselves {'–'} nothing needs re-uploading.
                <div className="mono" style={s('margin-top:5px;font-size:11px;max-height:96px;overflow:auto')}>
                  {noPrice.slice(0, 20).map((x, i) => (
                    <div key={i}>{x}</div>
                  ))}
                  {noPrice.length > 20 && <div>{'…'}</div>}
                </div>
              </div>
            )}
            <div className="tw" style={s('max-height:220px;overflow:auto;margin-top:12px')}>
              <table>
                <thead>
                  <tr>
                    <th style={s('width:110px')}>Code</th>
                    <th>Recipe</th>
                    <th className="c" style={s('width:60px')}>
                      Type
                    </th>
                    <th className="c" style={s('width:50px')}>
                      Lines
                    </th>
                    <th className="c" style={s('width:70px')}>
                      Output
                    </th>
                    <th className="n" style={s('width:110px')}>
                      Cost from the list
                    </th>
                    <th className="c" style={s('width:80px')}>
                      Priced
                    </th>
                    <th className="c" style={s('width:80px')}>
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cards.slice(0, 120).map((g, i) => (
                    <tr key={i}>
                      <td className="mono" style={s('font-weight:700;color:var(--org-dk)')}>
                        {g.code || 'auto'}
                      </td>
                      <td>{g.name || '—'}</td>
                      <td className="c">
                        <span className={`pill ${g.type === 'SUB' ? 'p-sub' : 'p-menu'}`}>
                          {g.type === 'SUB' ? 'Sub' : 'Menu'}
                        </span>
                      </td>
                      <td className="c">{g.lines.length}</td>
                      <td className="c">{g.out}</td>
                      <td className="n">{cur(g.libCost)}</td>
                      <td className="c">
                        {g.noPrice ? (
                          <span className="pill p-bad" title={`${g.noPrice} line(s) have no purchase price`}>
                            {g.lines.length - g.noPrice}/{g.lines.length}
                          </span>
                        ) : (
                          <span className="pill p-ok">all</span>
                        )}
                      </td>
                      <td className="c">
                        {g.action === 'add' ? (
                          <span className="pill p-ok">New</span>
                        ) : g.action === 'update' ? (
                          <span className="pill p-sub">Update</span>
                        ) : g.action === 'locked' ? (
                          <span className="pill p-lock">Locked</span>
                        ) : g.action === 'blocked' ? (
                          <span className="pill p-bad">Blocked</span>
                        ) : (
                          <span className="pill p-gr">Skip</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cards.length > 120 && (
              <div style={s('font-size:11.5px;color:var(--mute);margin-top:6px')}>Showing the first 120.</div>
            )}
          </>
        ),
        foot: (
          <>
            <button className="btn o" onClick={upload}>
              Back
            </button>
            <button className="btn" disabled={!(nAdd + nUpd) || nBlocked > 0} onClick={commit}>
              Load {nAdd + nUpd} card{nAdd + nUpd === 1 ? '' : 's'}
            </button>
          </>
        ),
      });
    }

    modal.open({
      title: 'Upload recipe cards from Excel',
      body: <RecipeUploadBody st={st} onFile={pickFile} templates={templateMenu} />,
      foot: (
        <button className="btn o" onClick={modal.close}>
          Cancel
        </button>
      ),
    });
  }, [brands, modal, router, templateMenu, toast, workspace]);

  return { exportAll, templateMenu, upload };
}

function RecipeUploadBody({
  st,
  onFile,
  templates,
}: {
  st: Store<{ brandId: string; takePrice: boolean; allowUpdate: boolean; grant: boolean }>;
  onFile: (f: File | undefined) => void;
  templates: () => void;
}) {
  const f = useStore(st);
  const { brands } = useSession();
  return (
    <>
      <div className="note" style={s('margin:0 0 14px')}>
        <b>One file, every brand.</b> Put a <b>Brand</b> column in the sheet and each card goes to the brand named on
        its row {'–'} the code (
        {brands
          .slice(0, 4)
          .map((b) => b.code)
          .join(', ')}
        {'…'}) or the full name both work. Item codes are shared across brands, so the same ingredient line costs
        identically everywhere.
      </div>
      <div className="field">
        <label className="fl">Brand for rows that do not name one</label>
        <select value={f.brandId} onChange={(e) => st.set({ brandId: e.target.value })}>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} ({b.code})
            </option>
          ))}
        </select>
        <div style={s('font-size:11.5px;color:var(--mute);margin-top:6px')}>
          Used only where the Brand column is blank or missing. Cards without their own code get the next free{' '}
          <span className="mono">####</span> number in whichever brand they land in.
        </div>
      </div>
      <div className="note" style={s('margin:0 0 14px')}>
        <b>Your prices are safe.</b> Ingredient purchase prices are never read from the file {'–'} every line is costed
        from the Ingredient Library already in the system. Nothing in the price list is touched.
      </div>
      <div className="field">
        <label className="fl">Options</label>
        <label
          style={s('display:flex;gap:8px;align-items:flex-start;font-size:12.5px;cursor:pointer;margin-bottom:8px')}
        >
          <input
            type="checkbox"
            checked={f.takePrice}
            style={s('margin-top:2px')}
            onChange={(e) => st.set({ takePrice: e.target.checked })}
          />
          <span>
            Also take the <b>Sales Price</b> column from the file{' '}
            <span style={s('color:var(--mute)')}>
              (the menu selling price only {'–'} ingredient costs always come from the Ingredient Library, never from
              the file. Off = keep the price already on the card)
            </span>
          </span>
        </label>
        <label
          style={s('display:flex;gap:8px;align-items:flex-start;font-size:12.5px;cursor:pointer;margin-bottom:8px')}
        >
          <input
            type="checkbox"
            checked={f.allowUpdate}
            style={s('margin-top:2px')}
            onChange={(e) => st.set({ allowUpdate: e.target.checked })}
          />
          <span>
            Overwrite cards whose code already exists{' '}
            <span style={s('color:var(--mute)')}>(off = those rows are skipped)</span>
          </span>
        </label>
        <label style={s('display:flex;gap:8px;align-items:flex-start;font-size:12.5px;cursor:pointer')}>
          <input
            type="checkbox"
            checked={f.grant}
            style={s('margin-top:2px')}
            onChange={(e) => st.set({ grant: e.target.checked })}
          />
          <span>
            Open up any brand-restricted ingredient to the brands that use it{' '}
            <span style={s('color:var(--mute)')}>(adds access only {'–'} never removes it, never touches a price)</span>
          </span>
        </label>
      </div>
      <p style={s('font-size:13px;color:var(--mute);margin-bottom:6px')}>
        One row per ingredient line. Only the output and the quantities are read {'–'} pricing comes from the item code.
        Columns:
      </p>
      <p
        className="mono"
        style={s(
          'background:var(--org-xl);padding:10px;border-radius:7px;margin:0 0 10px;font-size:11px;line-height:1.7',
        )}
      >
        {RTPL_HEAD.join(' · ')}
      </p>
      <p style={s('font-size:12.5px;color:var(--mute)')}>
        Column order does not matter {'–'} the header row is read by name. Approved (locked) cards are never
        overwritten. Nothing is deleted.
      </p>
      <div style={s('display:flex;gap:9px;margin-top:16px')}>
        <button className="btn o" style={s('flex:1;justify-content:center')} onClick={templates}>
          Get a template
        </button>
        <label className="btn" style={s('flex:1;justify-content:center')}>
          Choose Excel or CSV
          <input
            type="file"
            accept=".xlsx,.xlsm,.csv,.txt"
            style={s('display:none')}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              onFile(file);
            }}
          />
        </label>
      </div>
    </>
  );
}
