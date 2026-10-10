import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/auth/types';
import type { Role } from '@/lib/permissions';
import { parseRecipeSheets } from '@/lib/import/recipes';
import { previewRecipeImport, recipeImportIn } from '@/lib/services/import-recipes';
import { visibleBrandIds } from '@/lib/db/scope';
import { readSheets } from '@/lib/xlsx/read';
import { xlsxBytes } from '@/lib/xlsx/write';
import { connect, hasTestDb, insertBrand } from './helpers';

const h = vi.hoisted(() => ({ client: null as unknown as import('pg').Client, session: null as unknown }));
vi.mock('@/lib/db/client', async (orig) => {
  const actual = await orig<typeof import('@/lib/db/client')>();
  return {
    ...actual,
    db: { query: (t: string, v?: unknown[]) => h.client.query(t, v) },
    withTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      await h.client.query('SAVEPOINT ex');
      try {
        const r = await fn(h.client);
        await h.client.query('RELEASE SAVEPOINT ex');
        return r;
      } catch (e) {
        await h.client.query('ROLLBACK TO SAVEPOINT ex');
        throw e;
      }
    },
  };
});
vi.mock('@/lib/auth/session', () => ({ getSession: async () => h.session }));
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));

const ctx = (kind = 'x') => ({ params: Promise.resolve({ kind }) });

describe.skipIf(!hasTestDb)('exports (D-36, D-44) and the export -> upload round trip', { timeout: 280_000 }, () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = await connect();
    h.client = c;
  }, 60_000);
  afterAll(async () => {
    await c.end();
  });
  beforeEach(async () => {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.query('BEGIN');
  });

  async function mkUser(role: Role, brandIds: string[]): Promise<SessionUser> {
    const { rows } = await c.query(`INSERT INTO app_user (clerk_user_id, name) VALUES ($1,$2) RETURNING id`, [
      `clerk-${role}-${Math.random()}`,
      `T ${role}`,
    ]);
    for (const b of brandIds)
      await c.query('INSERT INTO user_brand_access (user_id, brand_id) VALUES ($1,$2)', [rows[0]!.id, b]);
    return { id: rows[0]!.id as string, clerkUserId: 'c', email: null, name: `T ${role}`, role };
  }
  const as = (u: SessionUser) => (h.session = { status: 'ok', user: u });
  const get = async (kind: string, qs = '') => {
    const { GET } = await import('@/app/api/export/[kind]/route');
    return GET(new Request(`http://x/api/export/${kind}${qs}`), ctx(kind));
  };
  const exportedRows = async (u: SessionUser) =>
    Number(
      (await c.query(`SELECT count(*) AS n FROM audit_log WHERE action = 'Exported data' AND user_id = $1`, [u.id]))
        .rows[0]!.n,
    );

  it('every kind answers, is audited once with kind and row count, and a viewer may export', async () => {
    const viewer = await mkUser('viewer', []);
    const gm = await mkUser('gm', []);
    as(gm);
    const kinds: [string, string][] = [
      ['recipes', ''],
      ['recipe-lines', ''],
      ['ingredients', ''],
      ['price-template', '?brand=*'],
      ['requisition', '?month=2026-10&day=10&brand=*&loc=*'],
      ['production', '?month=2026-10&brand=*&loc=*'],
      ['prep', '?month=2026-10&day=10&wd=SATURDAY&loc=*'],
    ];
    for (const [k, qs] of kinds) {
      const before = await exportedRows(gm);
      const res = await get(k, qs);
      expect(res.status, k).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/csv/);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect((await res.text()).length).toBeGreaterThan(20);
      expect(await exportedRows(gm), k).toBe(before + 1);
    }
    const a = await c.query(
      `SELECT detail FROM audit_log WHERE action = 'Exported data' AND user_id = $1 AND detail LIKE 'prep:%'`,
      [gm.id],
    );
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]!.detail).toMatch(/^prep: \d+ rows?$/);
    as(viewer);
    expect((await get('ingredients')).status).toBe(200);
    expect((await get('nope')).status).toBe(404);
  });

  it('a failed export writes no audit row; the plan export is SSEM-only', async () => {
    const brand = await insertBrand(c, 'XA');
    const cc = await mkUser('cc', [brand]);
    as(cc);
    const before = await exportedRows(cc);
    expect((await get('plan', '?menuId=whatever')).status).toBe(404);
    expect((await get('requisition', '?brand=*')).status).toBe(400);
    expect(await exportedRows(cc)).toBe(before);
  });

  it('formula starters are neutralised in CSV cells; money/price text is untouched', async () => {
    const brand = await insertBrand(c, 'XB');
    const gm = await mkUser('gm', []);
    await c.query(
      `INSERT INTO ingredient (code, name, uom, price, category, subcategory) VALUES ('XB-1', '=HYPERLINK("http://evil","x")', 'Gram', 0.0000800001, '+cmd', '@sum')`,
    );
    await c.query('INSERT INTO item_brand_scope SELECT id, $1 FROM ingredient WHERE code = $2', [brand, 'XB-1']);
    as(gm);
    const text = await (await get('ingredients')).text();
    const line = text.split('\n').find((l) => l.startsWith('XB-1'))!;
    expect(line).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(line).toContain(',0.000080,'); // 6 dp, never rounded to zero
    expect(line).toContain("'+cmd");
    expect(line).toContain("'@sum");
  });

  it('brand scope: a user without a card sees none of the other brands in the recipe exports', async () => {
    const brand = await insertBrand(c, 'XC');
    const narrow = await mkUser('cc', [brand]);
    as(narrow);
    const csv = (await (await get('recipes')).text()).split('\n');
    expect(csv).toHaveLength(1); // header only
    const lines = (await (await get('recipe-lines')).text()).split('\n');
    expect(lines).toHaveLength(1);
    const data = (await (await get('recipes-data', '?brand=*')).json()) as { rows: unknown[][] };
    expect(data.rows).toHaveLength(1);
    expect((await get('recipes-data', '?brand=SOMEONE-ELSE')).status).toBe(404);
  });

  it('production export: the intended columns (D-19) with one row per site/dish and a DAY TOTAL row', async () => {
    const gm = await mkUser('gm', []);
    as(gm);
    const r = (
      await c.query(`SELECT code FROM recipe WHERE type = 'MENU' AND deleted_at IS NULL ORDER BY code LIMIT 2`)
    ).rows;
    for (const [i, row] of r.entries()) {
      await c.query(
        `INSERT INTO production_entry (month, day, location, recipe_code, portions) VALUES ('2098-04','05','NIC',$1,$2), ('2098-04','05','',$1,$3)`,
        [row.code, 10 + i, 3],
      );
    }
    const lines = (await (await get('production', '?month=2098-04&brand=*&loc=*')).text()).split('\n');
    expect(lines[0]).toBe('Month,Day,Site,Brand,Section,Dish,Code,Portions,Cost/portion,Cost');
    expect(lines.filter((l) => l.includes(',NIC,')).length).toBe(2);
    expect(lines.filter((l) => l.includes(',-,')).length).toBe(2); // unassigned bucket shown as "-"
    const total = lines.find((l) => l.includes('DAY TOTAL'))!;
    expect(total.split(',')[7]).toBe(String(10 + 11 + 3 + 3));
  });

  it('recipes-data -> xlsx -> parse -> dry-run: exporting every card and uploading it back changes nothing', async () => {
    const gm = await mkUser('gm', []);
    as(gm);
    const { rows } = (await (await get('recipes-data', '?brand=*')).json()) as { rows: unknown[][] };
    expect(rows[0]).toContain('Waste %');
    expect(rows[0]).toContain('Card Buffer');
    const sheets = await readSheets({ name: 'all.xlsx', bytes: xlsxBytes(rows) });
    const parsed = parseRecipeSheets(sheets);
    const live = Number((await c.query('SELECT count(*) AS n FROM recipe WHERE deleted_at IS NULL')).rows[0]!.n);
    expect(parsed.cards).toHaveLength(live);
    expect(parsed.warn).toEqual([]);
    const brand = (await c.query('SELECT id FROM brand ORDER BY legacy_id LIMIT 1')).rows[0]!.id as string;
    // preview a slice of cards (the whole file is chunked in the UI); nothing may be blocked and everything is an update
    const sample = parsed.cards.filter((x) => x.lines.length).slice(0, 40);
    const input = recipeImportIn.parse({
      cards: sample,
      defaultBrandId: brand,
      takePrice: false,
      allowUpdate: true,
      grant: false,
    });
    const scope = await visibleBrandIds(gm, c);
    const plan = await previewRecipeImport(c, gm, scope, input);
    expect(plan.counts.blocked).toBe(0);
    expect(plan.cards.every((x) => x.action === 'update')).toBe(true);
    // lines survive the round trip exactly (codes, quantities, waste %)
    for (const card of sample.slice(0, 5)) {
      const stored = (
        await c.query(
          `SELECT l.code, l.qty, l.yp FROM recipe_line l JOIN recipe r ON r.id = l.recipe_id WHERE r.code = $1 AND r.deleted_at IS NULL ORDER BY l.sort_order`,
          [card.code],
        )
      ).rows;
      const nonBlank = stored.filter((l) => l.code);
      expect(card.lines.map((l) => [l.code, l.qty])).toEqual(nonBlank.map((l) => [l.code, l.qty]));
      expect(card.lines.map((l) => l.yp)).toEqual(nonBlank.map((l) => l.yp));
    }
  });
});
