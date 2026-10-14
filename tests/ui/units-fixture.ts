import type { UnitRow } from '@/lib/services/units';

/** The seeded unit list (migration 0013), as the Items screen receives it. */
export const unitList: UnitRow[] = [
  { code: 'Gram', kind: 'mass', toBase: 1, used: 0 },
  { code: 'Kg', kind: 'mass', toBase: 1000, used: 0 },
  { code: 'Ml', kind: 'volume', toBase: 1, used: 0 },
  { code: 'L', kind: 'volume', toBase: 1000, used: 0 },
  { code: 'Each', kind: 'each', toBase: 1, used: 0 },
  { code: 'Slice', kind: 'slice', toBase: 1, used: 0 },
  { code: 'Carton', kind: 'pack', toBase: null, used: 0 },
  { code: 'Box', kind: 'pack', toBase: null, used: 0 },
  { code: 'Bag', kind: 'pack', toBase: null, used: 0 },
  { code: 'Tray', kind: 'pack', toBase: null, used: 0 },
  { code: 'Pack', kind: 'pack', toBase: null, used: 0 },
];
