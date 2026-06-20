import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SpendClass } from './types.js';

// A user-defined rule: when a transaction description contains `match`
// (case-insensitive), force it into `category`. Optionally pin the class for a
// custom category the tool doesn't already know. Lets you classify P2P payments
// (Zelle/Venmo) and anything else only you can interpret — e.g. child support,
// rent to a person, a side-gig payout — without hardcoding into the tool.
export interface OverrideRule {
  match: string;
  category: string;
  class?: SpendClass;
}

// Looks for `overrides.json` in the given directories (first match wins).
// Accepts either a bare array of rules or `{ "version": 1, "rules": [...] }`.
export function loadOverrides(dirs: string[]): OverrideRule[] {
  for (const dir of dirs) {
    const path = join(dir, 'overrides.json');
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      const rules = Array.isArray(data) ? data : data.rules;
      if (Array.isArray(rules)) {
        return rules.filter((r): r is OverrideRule => !!r && typeof r.match === 'string' && typeof r.category === 'string');
      }
    } catch {
      console.warn(`  ⚠ ignoring malformed overrides.json in ${dir}`);
    }
  }
  return [];
}
