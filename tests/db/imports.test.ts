import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/auth/types';
import { makeScope } from '@/lib/db/scope';
import { ApiError } from '@/lib/errors';
import type { Role } from '@/lib/permissions';
import { commitItemImport, previewItemImport, type ItemImportIn } from '@/lib/services/import-items';
import { commitRecipeImport, previewRecipeImport, type RecipeImportIn } from '@/lib/services/import-recipes';
import { createIngredient } from '@/lib/services/ingredients';
import { connect, hasTestDb, inRollback, insertBrand } from './helpers';

vi.mock('@/lib/db/catalog-cache', () => ({ getCatalog: vi.fn(), CATALOG_TAG: 'catalog' }));

const U = (role: Role): SessionUser => ({
  id: `u-${role}`,
  clerkUserId: `c-${role}`,
  email: null,
  name: `T ${role}`,
  role,
});
const gm = U('gm');

async function fail(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected an ApiError');
}

const itemIn = (rows: ItemImportIn['rows'], over: Partial<ItemImportIn> = {}): ItemImportIn => ({
  rows,
  brandId: '',
  grant: true,
  file: 'prices.csv',
  ...over,
});
const irow = (code: string, price: number | null, extra: Partial<ItemImportIn['rows'][number]> = {}) => ({
  code,
  name: `Name ${code}`,
  uom: 'Gram' as const,
  price,
  cat: '',
  sub: '',
  line: 2,
  ...extra,
});

describe.skipIf(!hasTestDb)('price-list import (D-37, D-43)', { timeout: 120_000 }, () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = await connect();
  }, 60_000);
  afterAll(async () => {
    await c.end();
  });

  const mk = async (
    scope: ReturnType<typeof makeScope>,
    code: string,
    price: number | null,
    extra: { flag?: string; brandIds?: string[] } = {},
  ) =>
    createIngredient(c, gm, scope, {
      code,
      name: `Name ${code}`,
      uom: 'Gram',
      price,
      category: 'c',
      subcategory: 's',
      flag: extra.flag ?? '',
      brandIds: extra.brandIds ?? [],
    });

  it('dry-run classifies rows; variance beyond 20% (strictly) is PRICE CHECK; a missing old price is a new price, never a variance', () =>
    inRollback(c, async () => {
      const scope = makeScope([await insertBrand(c, 'IA')]);
      await mk(scope, 'IMP-A', 10);
      await mk(scope, 'IMP-B', 10);
      await mk(scope, 'IMP-C', 10);
      await mk(scope, 'IMP-D', null);
      await mk(scope, 'IMP-E', 5);
      const plan = await previewItemImport(
        c,
        gm,
        scope,
        itemIn([
          irow('IMP-A', 12), // exactly +20.0% -> not flagged
          irow('IMP-B', 12.5), // +25% -> flagged
          irow('IMP-C', 10, { name: 'Name IMP-C' }), // unchanged
          irow('IMP-D', 3), // old null -> new price
          irow('IMP-E', null), // empty price cell keeps the price
          irow('IMP-NEW', 1),
        ]),
      );
      const by = Object.fromEntries(plan.rows.map((r) => [r.code, r]));
      expect(by['IMP-A']).toMatchObject({ action: 'update', pct: 0.2, check: false });
      expect(by['IMP-B']).toMatchObject({ action: 'update', check: true });
      expect(by['IMP-C']!.action).toBe('same');
      expect(by['IMP-D']).toMatchObject({ action: 'update', pct: null, check: false });
      expect(by['IMP-E']).toMatchObject({ action: 'same', hasPrice: false });
      expect(by['IMP-NEW']!.action).toBe('add');
      expect(plan.counts).toMatchObject({ add: 1, update: 3, same: 2, keepPrice: 1, priceCheck: 1 });
    }));

  it('commit needs the dry-run hash, writes history (source IMPORT), appends PRICE CHECK once keeping existing flags, creates scoped new items, audits', () =>
    inRollback(c, async () => {
      const brand = await insertBrand(c, 'IB');
      const scope = makeScope([brand]);
      await mk(scope, 'IMP-F', 10, { flag: 'UNIT CHECK' });
      await mk(scope, 'IMP-G', 10, { flag: 'PRICE CHECK' });
      const input = itemIn(
        [irow('IMP-F', 20), irow('IMP-G', 20), irow('IMP-H', 0.0000800001, { cat: 'Fresh', sub: 'Produce' })],
        { brandId: brand },
      );
      const plan = await previewItemImport(c, gm, scope, input);
      expect((await fail(commitItemImport(c, gm, scope, input))).status).toBe(409); // no hash
      expect((await fail(commitItemImport(c, gm, scope, { ...input, hash: 'x' }))).status).toBe(409);
      const out = await commitItemImport(c, gm, scope, { ...input, hash: plan.hash });
      expect(out).toMatchObject({ added: 1, updated: 2, flagged: 1 });
      const rows = (
        await c.query(
          `SELECT code, price, flag, category FROM ingredient WHERE code IN ('IMP-F','IMP-G','IMP-H') ORDER BY code`,
        )
      ).rows;
      expect(rows[0]).toMatchObject({ code: 'IMP-F', price: 20, flag: 'UNIT CHECK | PRICE CHECK' });
      expect(rows[1]).toMatchObject({ code: 'IMP-G', flag: 'PRICE CHECK' }); // not appended twice
      expect(rows[2]).toMatchObject({ code: 'IMP-H', price: 0.0000800001, category: 'Fresh' }); // precision kept
      const sc = await c.query(
        `SELECT count(*)::int AS n FROM item_brand_scope s JOIN ingredient i ON i.id = s.ingredient_id WHERE i.code = 'IMP-H'`,
      );
      expect(sc.rows[0]!.n).toBe(1);
      const h = await c.query(
        `SELECT old_price, new_price, source FROM ingredient_price_history h JOIN ingredient i ON i.id = h.ingredient_id WHERE i.code = 'IMP-F'`,
      );
      expect(h.rows.find((x) => x.new_price === 20)).toMatchObject({ old_price: 10, source: 'IMPORT' });
      const a = await c.query(
        `SELECT detail FROM audit_log WHERE action = 'Uploaded price list' ORDER BY created_at DESC LIMIT 1`,
      );
      expect(a.rows[0]!.detail).toContain('1 added, 2 updated');
    }));

  it('permissions and scope: items.edit needed; scoped items of other brands are blocked; foreign brand target refused; duplicates in a part refused', () =>
    inRollback(c, async () => {
      const mine = await insertBrand(c, 'IC');
      const other = await insertBrand(c, 'ID');
      const scope = makeScope([mine]);
      await mk(makeScope([other]), 'IMP-X', 1, { brandIds: [other] });
      expect((await fail(previewItemImport(c, U('chef'), scope, itemIn([irow('IMP-Y', 1)])))).status).toBe(403);
      expect(
        (await fail(previewItemImport(c, U('cc'), scope, itemIn([irow('IMP-Y', 1)], { brandId: other })))).status,
      ).toBe(403);
      const plan = await previewItemImport(c, U('cc'), scope, itemIn([irow('IMP-X', 2), irow('IMP-Z', 1)]));
      expect(plan.rows.find((r) => r.code === 'IMP-X')).toMatchObject({ action: 'blocked' });
      const input = itemIn([irow('IMP-X', 2)]);
      const p2 = await previewItemImport(c, U('cc'), scope, input);
      expect((await fail(commitItemImport(c, U('cc'), scope, { ...input, hash: p2.hash }))).status).toBe(422);
      expect((await fail(previewItemImport(c, gm, scope, itemIn([irow('DUP', 1), irow('DUP', 2)])))).status).toBe(400);
    }));

  it('grant: an existing brand-scoped item is opened to the chosen brand only when asked', () =>
    inRollback(c, async () => {
      const a = await insertBrand(c, 'IE');
      const b = await insertBrand(c, 'IF');
      const scope = makeScope([a, b]);
      await mk(scope, 'IMP-S', 1, { brandIds: [a] });
      for (const grant of [false, true]) {
        const input = itemIn([irow('IMP-S', 1)], { brandId: b, grant });
        const plan = await previewItemImport(c, gm, scope, input);
        await commitItemImport(c, gm, scope, { ...input, hash: plan.hash });
        const n = (
          await c.query(
            `SELECT count(*)::int AS n FROM item_brand_scope s JOIN ingredient i ON i.id = s.ingredient_id WHERE i.code = 'IMP-S'`,
          )
        ).rows[0]!.n;
        expect(n).toBe(grant ? 2 : 1);
      }
    }));
});

const card = (
  over: Partial<RecipeImportIn['cards'][number]> & { lines?: RecipeImportIn['cards'][number]['lines'] },
): RecipeImportIn['cards'][number] => ({
  brand: '',
  code: '',
  name: 'Imported',
  cat: '',
  type: '',
  out: null,
  bout: null,
  buom: '',
  price: null,
  buffer: null,
  lines: [],
  method: [],
  rows: [],
  ...over,
});
const ln = (code: string, qty = 1, extra: Partial<RecipeImportIn['cards'][number]['lines'][number]> = {}) => ({
  code,
  qty,
  unit: '' as const,
  y: 1,
  yp: null,
  ...extra,
});
const rin = (cards: RecipeImportIn['cards'], brand: string, over: Partial<RecipeImportIn> = {}): RecipeImportIn => ({
  cards,
  defaultBrandId: brand,
  takePrice: false,
  allowUpdate: true,
  grant: true,
  file: 'cards.xlsx',
  ...over,
});

describe.skipIf(!hasTestDb)('recipe import (D-12, D-13, D-17, D-37)', { timeout: 120_000 }, () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = await connect();
  }, 60_000);
  afterAll(async () => {
    await c.end();
  });

  async function world() {
    const brand = await insertBrand(c, 'RI');
    const other = await insertBrand(c, 'RJ');
    const scope = makeScope([brand, other]);
    await createIngredient(c, gm, scope, {
      code: 'RIM-1',
      name: 'One',
      uom: 'Gram',
      price: 2,
      category: 'Fresh',
      subcategory: 's',
      flag: '',
      brandIds: [],
    });
    await createIngredient(c, gm, scope, {
      code: 'RIM-2',
      name: 'Two',
      uom: 'Each',
      price: null,
      category: 'Non Food',
      subcategory: 's',
      flag: '',
      brandIds: [],
    });
    return { brand, other, scope };
  }
  const apply = async (scope: ReturnType<typeof makeScope>, input: RecipeImportIn, user = gm) => {
    const plan = await previewRecipeImport(c, user, scope, input);
    return { plan, out: await commitRecipeImport(c, user, scope, { ...input, hash: plan.hash }) };
  };

  it('adds cards: brand by code or name, unknown brand falls to the default, auto code, lines costed from the library, units from the library, audit', () =>
    inRollback(c, async () => {
      const { brand, other, scope } = await world();
      const { plan, out } = await apply(
        scope,
        rin(
          [
            card({ brand: 'RJ', name: 'To other', lines: [ln('RIM-1', 100)] }),
            card({
              brand: 'nowhere',
              name: 'To default',
              code: 'ri-mn-0500',
              lines: [ln('RIM-1', 5, { unit: 'Ml' }), ln('RIM-2', 2)],
              method: ['a', 'b'],
              bout: 300,
              buom: 'Gram',
              out: 4,
            }),
          ],
          brand,
        ),
      );
      expect(plan.counts).toMatchObject({ add: 2, blocked: 0, lines: 3 });
      expect(plan.cards[1]).toMatchObject({ badBrand: 'nowhere', brandId: brand, noPrice: 1, pkgLines: 1 });
      expect(plan.cards[1]!.conv).toHaveLength(1); // RIM-1 is Gram, written in Ml, no conversion
      expect(out).toMatchObject({ added: 2, updated: 0 });
      const rows = (
        await c.query(
          `SELECT code, brand_id, output, batch_out, batch_uom FROM recipe WHERE name IN ('To other','To default') ORDER BY name`,
        )
      ).rows;
      expect(rows[0]!.brand_id).toBe(brand);
      expect(rows[0]).toMatchObject({ code: 'RI-MN-0500', output: 4, batch_out: 300 });
      expect(rows[1]).toMatchObject({ brand_id: other });
      expect(rows[1]!.code).toMatch(/^RJ-MN-\d{4}$/);
      const lines = (
        await c.query(
          `SELECT l.code, l.unit FROM recipe_line l JOIN recipe r ON r.id = l.recipe_id WHERE r.code = 'RI-MN-0500' ORDER BY sort_order`,
        )
      ).rows;
      expect(lines).toEqual([
        { code: 'RIM-1', unit: 'Ml' },
        { code: 'RIM-2', unit: 'Each' },
      ]); // blank unit -> library unit
      const a = await c.query(
        `SELECT detail FROM audit_log WHERE action = 'Uploaded recipe cards' ORDER BY created_at DESC LIMIT 1`,
      );
      expect(a.rows[0]!.detail).toContain('2 added');
    }));

  it('blocks unknown / unavailable item codes, ingredient-code collisions and duplicate codes; commit refuses the whole part', () =>
    inRollback(c, async () => {
      const { brand, scope } = await world();
      const input = rin(
        [
          card({ name: 'Bad lines', lines: [ln('NOPE-9')] }),
          card({ name: 'Clash', code: 'rim-1', lines: [ln('RIM-1')] }),
          card({ name: 'First', code: 'DUP-1', lines: [ln('RIM-1')] }),
          card({ name: 'Second', code: 'dup-1', lines: [ln('RIM-1')] }),
          card({ name: 'Fine', lines: [ln('RIM-1')] }),
        ],
        brand,
      );
      const plan = await previewRecipeImport(c, gm, scope, input);
      expect(plan.cards.map((x) => x.action)).toEqual(['blocked', 'blocked', 'add', 'blocked', 'add']);
      expect(plan.cards[0]!.reason).toMatch(/NOPE-9/);
      expect(plan.cards[1]!.reason).toMatch(/ingredient/);
      expect((await fail(commitRecipeImport(c, gm, scope, { ...input, hash: plan.hash }))).status).toBe(422);
      expect((await c.query(`SELECT count(*)::int AS n FROM recipe WHERE name = 'Fine'`)).rows[0]!.n).toBe(0); // nothing written
    }));

  it('updates: locked cards skipped, overwrite off skips, waste % carried over when the file has none, buffer untouched, price only when asked', () =>
    inRollback(c, async () => {
      const { brand, scope } = await world();
      const first = await apply(
        scope,
        rin(
          [card({ name: 'Upd', code: 'RI-MN-0600', buffer: 0.2, lines: [ln('RIM-1', 10, { yp: 12.5 })], price: 40 })],
          brand,
          { takePrice: true },
        ),
      );
      expect(first.out.added).toBe(1);
      expect(
        (await c.query(`SELECT selling_price, buffer FROM recipe WHERE code = 'RI-MN-0600'`)).rows[0],
      ).toMatchObject({ selling_price: 40, buffer: 0.2 });
      // file with no waste/buffer/price: stored values stand
      const second = await apply(
        scope,
        rin([card({ name: 'Upd v2', code: 'ri-mn-0600', lines: [ln('RIM-1', 20)], price: 99 })], brand),
      );
      expect(second.out).toMatchObject({ added: 0, updated: 1 });
      const r = (
        await c.query(
          `SELECT r.name, r.selling_price, r.buffer, l.qty, l.yp FROM recipe r JOIN recipe_line l ON l.recipe_id = r.id WHERE r.code = 'RI-MN-0600'`,
        )
      ).rows[0]!;
      expect(r).toMatchObject({ name: 'Upd v2', selling_price: 40, buffer: 0.2, qty: 20, yp: 12.5 });
      // overwrite off
      const off = await previewRecipeImport(
        c,
        gm,
        scope,
        rin([card({ code: 'RI-MN-0600', lines: [ln('RIM-1')] })], brand, { allowUpdate: false }),
      );
      expect(off.cards[0]!.action).toBe('exists');
      // locked
      await c.query(`UPDATE recipe SET status = 'LOCKED' WHERE code = 'RI-MN-0600'`);
      const lockedIn = rin([card({ code: 'RI-MN-0600', lines: [ln('RIM-1', 77)] })], brand);
      const lk = await previewRecipeImport(c, gm, scope, lockedIn);
      expect(lk.cards[0]!.action).toBe('locked');
      const done = await commitRecipeImport(c, gm, scope, { ...lockedIn, hash: lk.hash });
      expect(done.updated).toBe(0);
      expect(
        (await c.query(`SELECT qty FROM recipe_line l JOIN recipe r ON r.id = l.recipe_id WHERE r.code = 'RI-MN-0600'`))
          .rows[0]!.qty,
      ).toBe(20);
    }));

  it('circular references across the file and the stored graph are refused (D-13); sub-recipes can be used as lines', () =>
    inRollback(c, async () => {
      const { brand, scope } = await world();
      await apply(
        scope,
        rin(
          [
            card({
              name: 'Sub A',
              code: 'RI-SR-0001',
              type: 'Sub',
              lines: [ln('RIM-1', 100)],
              bout: 100,
              buom: 'Gram',
            }),
          ],
          brand,
        ),
      );
      await apply(scope, rin([card({ name: 'Uses sub', code: 'RI-MN-0700', lines: [ln('RI-SR-0001', 5)] })], brand));
      await apply(
        scope,
        rin(
          [
            card({
              name: 'Sub B',
              code: 'RI-SR-0002',
              type: 'Sub',
              lines: [ln('RI-SR-0001', 1)],
              bout: 10,
              buom: 'Gram',
            }),
          ],
          brand,
        ),
      );
      const cyc = await previewRecipeImport(
        c,
        gm,
        scope,
        rin([card({ name: 'Sub A', code: 'RI-SR-0001', type: 'Sub', lines: [ln('RI-SR-0002', 1)] })], brand),
      );
      expect(cyc.cards[0]).toMatchObject({ action: 'blocked' });
      expect(cyc.cards[0]!.reason).toMatch(/circular/);
    }));

  it('authorisation: recipe.create needed; non-GM cannot create in or move cards between brands they do not have; target in a foreign brand is blocked', () =>
    inRollback(c, async () => {
      const { brand, other, scope } = await world();
      expect(
        (await fail(previewRecipeImport(c, U('viewer'), scope, rin([card({ lines: [ln('RIM-1')] })], brand)))).status,
      ).toBe(403);
      const narrow = makeScope([brand]);
      expect(
        (await fail(previewRecipeImport(c, U('chef'), narrow, rin([card({ lines: [ln('RIM-1')] })], other)))).status,
      ).toBe(403); // default brand not allowed
      const p = await previewRecipeImport(
        c,
        U('chef'),
        narrow,
        rin([card({ brand: 'RJ', lines: [ln('RIM-1')] })], brand),
      ); // names a brand outside the scope
      expect(p.cards[0]).toMatchObject({ action: 'blocked' });
      // an existing card of the other brand: blocked for the narrow user, a move for the wide one
      await apply(scope, rin([card({ brand: 'RJ', code: 'RJ-MN-0800', name: 'Theirs', lines: [ln('RIM-1')] })], brand));
      const t1 = await previewRecipeImport(
        c,
        U('chef'),
        narrow,
        rin([card({ code: 'RJ-MN-0800', lines: [ln('RIM-1')] })], brand),
      );
      expect(t1.cards[0]!.action).toBe('blocked');
      const t2 = await previewRecipeImport(
        c,
        gm,
        scope,
        rin([card({ code: 'RJ-MN-0800', lines: [ln('RIM-1')] })], brand),
      );
      expect(t2.cards[0]).toMatchObject({ action: 'update', movesFrom: expect.any(String) });
    }));

  it('grant: an item restricted to another brand is opened to the card brand when granting is on', () =>
    inRollback(c, async () => {
      const { brand, other, scope } = await world();
      await createIngredient(c, gm, scope, {
        code: 'RIM-R',
        name: 'Restricted',
        uom: 'Gram',
        price: 1,
        category: 'c',
        subcategory: 's',
        flag: '',
        brandIds: [other],
      });
      const { plan } = await apply(scope, rin([card({ name: 'Grants', lines: [ln('RIM-R')] })], brand));
      expect(plan.needGrant).toBe(1);
      const n = (
        await c.query(
          `SELECT count(*)::int AS n FROM item_brand_scope s JOIN ingredient i ON i.id = s.ingredient_id WHERE i.code = 'RIM-R'`,
        )
      ).rows[0]!.n;
      expect(n).toBe(2);
    }));
});
