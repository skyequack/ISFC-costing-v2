'use client';

import { useBackupIO } from '@/components/io/backup-io';
import { useItemIO } from '@/components/io/items-io';
import { useRecipeIO } from '@/components/io/recipes-io';
import { useStockTemplate } from '@/components/io/stock-template';
import { Perm } from '@/components/shared/Perm';
import { usePerm } from '@/components/shared/session-context';
import { s } from '@/components/ui';

export interface BackupCounts {
  items: number;
  recipes: number;
  conv: number;
  photos: number;
  photoKb: number;
}

/** Legacy vBackup (4371) minus the browser-storage controls that no longer exist (D-54). */
export function BackupScreen({ counts, sites }: { counts: BackupCounts; sites: string[] }) {
  const can = usePerm();
  const io = useBackupIO();
  const items = useItemIO([]);
  const recipes = useRecipeIO();
  const stockTemplate = useStockTemplate(sites);

  return (
    <>
      {!can('data.admin') && (
        <div className="rolebar">
          <b>Exports only.</b> Restoring or resetting the system is limited to a General Manager.
        </div>
      )}
      <div className="row r2" style={s('max-width:900px;align-items:start')}>
        <div className="card">
          <h3>Export</h3>
          <div className="bd">
            <p style={s('font-size:13px;color:var(--mute);margin-bottom:14px')}>
              A full JSON backup restores everything exactly. The CSVs are for Excel and reporting.
            </p>
            <div style={s('display:flex;flex-direction:column;gap:9px')}>
              <Perm perm="data.admin">
                <button className="btn" onClick={io.exportBackup}>
                  Download full backup (JSON)
                </button>
              </Perm>
              <button className="btn o" onClick={() => io.exportCsv('recipes')}>
                Recipe costing summary (CSV)
              </button>
              <button className="btn o" onClick={() => io.exportCsv('recipe-lines')}>
                All recipe lines (CSV)
              </button>
              <button className="btn o" onClick={() => recipes.exportAll('xlsx')}>
                All recipe cards, re-uploadable (Excel)
              </button>
              <button className="btn o" onClick={() => io.exportCsv('ingredients')}>
                Ingredient library (CSV)
              </button>
            </div>
          </div>
        </div>
        <div className="card">
          <h3>Restore &amp; Reset</h3>
          <div className="bd">
            <p style={s('font-size:13px;color:var(--mute);margin-bottom:14px')}>
              Restoring replaces everything currently in the system.
            </p>
            <div style={s('display:flex;flex-direction:column;gap:9px')}>
              <Perm perm="items.edit">
                <button className="btn o" onClick={items.upload}>
                  Upload a raw material price list
                </button>
              </Perm>
              <Perm perm="recipe.create">
                <button className="btn o" onClick={recipes.upload}>
                  Upload recipe cards (Excel)
                </button>
              </Perm>
              <Perm perm="data.admin">
                <label className="btn d" style={s('justify-content:center')}>
                  Restore from backup file
                  <input
                    type="file"
                    accept=".json"
                    style={s('display:none')}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) io.restore(f);
                    }}
                  />
                </label>
              </Perm>
            </div>
            <div
              style={s(
                'margin-top:16px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--mute)',
              )}
            >
              {counts.items} ingredients {'·'} {counts.recipes} recipe cards {'·'} {counts.conv} conversions
              <br />
              {counts.photos} dish photo{counts.photos === 1 ? '' : 's'} using {counts.photoKb} KB
              {counts.photoKb > 4000 && (
                <span style={s('color:var(--bad);font-weight:700')}> {'–'} getting heavy, consider removing some</span>
              )}
            </div>
          </div>
        </div>
        <div className="card">
          <h3>Import templates</h3>
          <div className="bd">
            <p style={s('font-size:13px;color:var(--mute);margin-bottom:14px')}>
              Fill one in, then upload it back where it belongs. Keep the heading row as it is.
            </p>
            <div style={s('display:flex;flex-direction:column;gap:9px')}>
              <button className="btn o" onClick={items.template}>
                Download a price list template
              </button>
              <Perm perm="recipe.create">
                <button className="btn o" onClick={recipes.templateMenu}>
                  Download a recipe template
                </button>
              </Perm>
              <Perm perm="stock.edit">
                <button className="btn o" onClick={() => stockTemplate('count')}>
                  Download a stock counts template
                </button>
              </Perm>
              <Perm perm="stock.edit">
                <button className="btn o" onClick={() => stockTemplate('receipt')}>
                  Download a stock receipts template
                </button>
              </Perm>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
