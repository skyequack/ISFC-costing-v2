import type { Permission } from './permissions';

/** Ported from legacy NAV / TITLES (legacy/app.html 1532-1549, 1601-1620). Wording verbatim (D-41 pending). */
export type NavEntry = { group: string } | { route: string; label: string; icon: string; perm?: Permission };

export const NAV: NavEntry[] = [
  { group: 'Operations' },
  { route: 'brands', label: 'Brand Workspaces', icon: '◱' },
  { route: 'dash', label: 'Dashboard', icon: '■' },
  { route: 'prep', label: 'Preparation', icon: '▶' },
  { route: 'prod', label: 'Production', icon: '⚙' },
  { route: 'plan', label: 'Menu Plans', icon: '☷' },
  { route: 'recipes', label: 'Recipe Cards', icon: '▤' },
  { group: 'Data' },
  { route: 'items', label: 'Ingredient Library', icon: '◎' },
  { route: 'conv', label: 'Unit Conversions', icon: '⇄' },
  { route: 'yields', label: 'Yield Reference', icon: '✂' },
  { group: 'Admin' },
  { route: 'settings', label: 'Cost Settings', icon: '⚙' },
  { route: 'health', label: 'Data Health', icon: '⚠' },
  { route: 'audit', label: 'Activity Log', icon: '☷', perm: 'audit.view' },
  { route: 'users', label: 'Users & Access', icon: '⚿', perm: 'users.manage' },
  { route: 'backup', label: 'Backup & Export', icon: '⤓' },
];

export const TITLES: Record<string, [string, string]> = {
  prod: ['Daily Production', 'How many portions each section cooks, kept day by day for the month'],
  prep: ['Preparation', 'Site, menu, headcount – then the materials to draw'],
  plan: ['Menu Plans', 'What is served each day, and what a day costs per person'],
  brands: ['Brand Workspaces', 'Pick the brand you are working on, then build its recipe cards'],
  dash: ['Dashboard', 'Live margin position across every recipe card'],
  recipes: ['Recipe Cards', 'Create, cost and price every dish'],
  edit: ['Recipe Card', ''],
  items: ['Ingredient Library', 'Master purchase prices - the single source of truth'],
  conv: ['Unit Conversions', 'Bridging Each and Slice purchases to kitchen weights'],
  yields: ['Yield Reference', 'Standard trim, cooking and absorption yields'],
  settings: ['Cost Settings', 'Global levers - every card reprices instantly'],
  users: ['Users & Access', 'Who can change what, and a record of who did'],
  audit: ['Activity Log', 'Every price change, edit and deletion, with a name against it'],
  health: ['Data Health', 'Problems that will produce a wrong cost'],
  backup: ['Backup & Export', 'Your data is stored securely in the database. Download a backup copy at any time.'],
};

export const SCREEN_ROUTES = Object.keys(TITLES);
