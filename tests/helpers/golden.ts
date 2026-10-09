import fs from 'node:fs';
import path from 'node:path';
import {
  buildContext,
  type ConvEntry,
  type CostContext,
  type CostItem,
  type CostRecipe,
  type CostSettings,
} from '@/domain/costing';

const root = path.resolve(__dirname, '../..');
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

interface GoldenState {
  settings: CostSettings & Record<string, unknown>;
  items: CostItem[];
  conv: Record<string, ConvEntry>;
  recipes: (CostRecipe & { id: string })[];
}

export const goldenState: GoldenState = read('golden/state.json');
export const goldenCosts: Record<string, Record<string, unknown>> = read('golden/costs.json');

export function goldenContext(over: Partial<CostSettings> = {}): CostContext {
  return buildContext(goldenState.items, goldenState.recipes, Object.entries(goldenState.conv), {
    ...goldenState.settings,
    ...over,
  });
}
