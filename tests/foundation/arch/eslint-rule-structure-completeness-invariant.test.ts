import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 597: invariant that every chestnut-custom ESLint rule under
 * .config/eslint-rules/*.js exports the structural quartet:
 *
 *   1. `meta.docs`     — human-readable description (IDE surfacing).
 *   2. `meta.schema`   — option validation; missing → options silently dropped.
 *   3. `meta.messages` — messageId mechanism; missing → context.report inline
 *                        string literals, breaking i18n + lint:lint quality bar.
 *   4. `create`        — visitor factory; missing → ESLint rule load failure.
 *
 * Pairs with phase 596 (meta.type='problem'), phase 593 (severity), phase 591
 * (3-way plugin/rules pairing), phase 589 (rule ↔ config import), phase 587
 * (RuleTester), phase 585 (phase reference).
 */
describe('ESLint chestnut-custom rule structural completeness (phase 597)', () => {
  it('every rule has meta.docs + meta.schema + meta.messages + create', async () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const offenders: string[] = [];
    for (const f of files) {
      const rulePath = path.join(rulesDir, f);
      const mod = (await import(rulePath)) as {
        default?: {
          meta?: { docs?: unknown; schema?: unknown; messages?: unknown };
          create?: unknown;
        };
      };
      const rule = mod?.default;
      const missing: string[] = [];
      if (!rule?.meta?.docs) missing.push('meta.docs');
      if (!rule?.meta?.schema) missing.push('meta.schema');
      if (!rule?.meta?.messages) missing.push('meta.messages');
      if (typeof rule?.create !== 'function') missing.push('create');
      if (missing.length > 0) offenders.push(`${f}: missing ${missing.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
