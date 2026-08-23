import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

function toolResultImportsFromTools(): string[] {
  const offenders: string[] = [];

  function scan(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;

      const text = fs.readFileSync(full, 'utf8');
      const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]*foundation\/tools\/index\.js)['"];?/g;
      let match: RegExpExecArray | null;
      while ((match = importRe.exec(text)) !== null) {
        if (/\bToolResult\b/.test(match[1])) {
          offenders.push(path.relative(root, full));
        }
      }
    }
  }

  scan(path.join(root, 'src'));
  return offenders;
}

describe('ToolResult owner boundary (phase 1494)', () => {
  it('ToolProtocol barrel remains the named export owner', () => {
    const barrel = read('src/foundation/tool-protocol/index.ts');
    expect(barrel).toMatch(/\bToolResult\b/);
  });

  it('Tools barrel does not re-export ToolResult', () => {
    const barrel = read('src/foundation/tools/index.ts');
    expect(barrel).not.toMatch(/export\s+type\s+\{\s*ToolResult\s*\}/);
  });

  it('no production caller imports ToolResult from Tools barrel', () => {
    expect(toolResultImportsFromTools()).toEqual([]);
  });

  it('Tools internal signatures still consume ToolResult from ToolProtocol', () => {
    const types = read('src/foundation/tools/types.ts');
    const executor = read('src/foundation/tools/executor.ts');
    expect(types).toMatch(/import\s+type\s+\{[^}]*ToolResult[^}]*\}\s+from\s+['"]\.\.\/tool-protocol\/index\.js['"]/);
    expect(executor).toMatch(/import\s+type\s+\{\s*ToolResult\s*\}\s+from\s+['"]\.\.\/tool-protocol\/index\.js['"]/);
  });

  it('SDK top-level export still points to ToolProtocol owner', () => {
    const sdk = read('src/index.ts');
    expect(sdk).toMatch(/export\s+type\s+\{\s*ToolResult\s*\}\s+from\s+['"]\.\/foundation\/tool-protocol\/index\.js['"]/);
  });
});
