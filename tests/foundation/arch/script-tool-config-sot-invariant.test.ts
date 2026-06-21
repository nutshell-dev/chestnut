import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 602: invariant that every package.json script invoking vitest /
 * depcruise / eslint / tsup references the corresponding config file under
 * `.config/`.
 *
 * Rationale (ML#3 single-source ownership): each tool's config SoT lives at
 * `.config/`, not repo root. A script that invokes a tool without the
 * explicit `--config` flag falls back to the tool's default config resolution
 * (which searches repo root), creating a silent split between two configs
 * that drift independently.
 *
 * Extends phase 600 (test* scripts → vitest config) to all four tools.
 */
const TOOL_CONFIG_PAIRS: Array<{ tool: string; config: string }> = [
  { tool: 'vitest', config: '.config/vitest.config.ts' },
  { tool: 'depcruise', config: '.config/dependency-cruiser.cjs' },
  { tool: 'eslint', config: '.config/eslint.config.js' },
  { tool: 'tsup', config: '.config/tsup.config.ts' },
];

describe('package.json tool config SoT invariant (phase 602)', () => {
  it('every script invoking a known tool references --config .config/<config>', () => {
    const pkgPath = path.resolve(__dirname, '../../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      scripts: Record<string, string>;
    };

    const offenders: string[] = [];
    for (const [name, value] of Object.entries(pkg.scripts)) {
      for (const { tool, config } of TOOL_CONFIG_PAIRS) {
        const toolPattern = new RegExp(`(^|[\\s&|])${tool}(\\s|$)`);
        if (!toolPattern.test(value)) continue;
        if (!value.includes(`--config ${config}`)) {
          offenders.push(`${name}: invokes ${tool} without --config ${config}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
