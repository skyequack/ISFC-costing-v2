/** Static reference data typed from db/seed-data/*.json (generated from the legacy file; never hand-edited). */
import sections from '../../db/seed-data/sections.json';
import planAlias from '../../db/seed-data/plan-alias.json';
import yieldRef from '../../db/seed-data/yield-ref.json';
import seedIssues from '../../db/seed-data/seed-issues.json';
import menuDays from '../../db/seed-data/menu-days.json';

/** [key, English label, Arabic label, category names] — legacy SECTIONS (2037). */
export type Section = readonly [string, string, string, readonly string[]];
export const SECTIONS = sections as unknown as readonly Section[];
export const PLAN_ALIAS = planAlias as Record<string, string>;
/** [category, item, yield fraction, note] — legacy YIELD_REF; display only, not used by costing. */
export const YIELD_REF = yieldRef as unknown as readonly (readonly [string, string, number, string])[];
export const SEED_ISSUES = seedIssues as unknown as readonly (readonly string[])[];
export const MENU_DAYS = menuDays as readonly string[];

/** Section key for a card category (legacy pSection 2070): exact trimmed match, default 'hot'. */
export function sectionOf(category: string): string {
  const c = (category || '').trim();
  for (const s of SECTIONS) if (s[3].includes(c)) return s[0];
  return 'hot';
}
