import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, '..', '..', '..', 'src');

/**
 * phase 1493 Step B: JSONSchema7 owner boundary ratchet.
 *
 * JSONSchema7 is owned by LLMProvider (L1). ToolProtocol (L2b) and Tools (L2c)
 * may import it internally for their own signatures, but must not re-export it.
 */
describe('JSONSchema7 owner boundary ratchet (phase 1493)', () => {
  /**
   * Forward assertion: owner barrel still exports the schema type.
   */
  it('LLMProvider barrel exports JSONSchema7', () => {
    const barrelText = fs.readFileSync(
      path.join(srcRoot, 'foundation', 'llm-provider', 'index.ts'),
      'utf8',
    );
    expect(barrelText).toMatch(/JSONSchema7/);
  });

  /**
   * Backward assertions: non-owner modules must not re-export JSONSchema7.
   */
  it('ToolProtocol barrel and types do not re-export JSONSchema7', () => {
    const barrelText = fs.readFileSync(
      path.join(srcRoot, 'foundation', 'tool-protocol', 'index.ts'),
      'utf8',
    );
    const typesText = fs.readFileSync(
      path.join(srcRoot, 'foundation', 'tool-protocol', 'types.ts'),
      'utf8',
    );
    expect(barrelText).not.toMatch(/\bJSONSchema7\b/);
    expect(typesText).not.toMatch(/^export type \{ JSONSchema7 \};/m);
  });

  it('Tools types does not re-export JSONSchema7', () => {
    const typesText = fs.readFileSync(
      path.join(srcRoot, 'foundation', 'tools', 'types.ts'),
      'utf8',
    );
    expect(typesText).not.toMatch(/^export type \{ JSONSchema7 \};/m);
  });

  /**
   * Scan all import declarations in src/.../*.ts and assert no declaration
   * imports JSONSchema7 from ToolProtocol barrel or Tools barrel.
   */
  it('no src file imports JSONSchema7 from tool-protocol or tools barrels', () => {
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
        // Match a single named-import declaration from any path ending in
        // tool-protocol/index.js or tools/index.js. `[^}]*` keeps the match
        // inside one brace pair, preventing cross-import false positives.
        const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]*(?:tool-protocol|tools)\/index\.js)['"];?/g;
        let m: RegExpExecArray | null;
        while ((m = importRe.exec(text)) !== null) {
          const braceContent = m[1];
          if (/\bJSONSchema7\b/.test(braceContent)) {
            const line = text.slice(0, m.index).split('\n').length;
            offenders.push(`${path.relative(srcRoot, full)}:${line}: ${m[0].split('\n')[0]}...`);
          }
        }
      }
    }

    scan(srcRoot);
    expect(offenders).toEqual([]);
  });

  /**
   * Invariant: non-owner modules still import JSONSchema7 internally for
   * their own signatures (prevents accidental removal of the import itself).
   */
  it('ToolProtocol types imports JSONSchema7 for ToolDescriptor.schema', () => {
    const typesText = fs.readFileSync(
      path.join(srcRoot, 'foundation', 'tool-protocol', 'types.ts'),
      'utf8',
    );
    expect(typesText).toMatch(/import\s+type\s+\{\s*JSONSchema7\s*\}\s+from\s+['"]\.\.\/llm-provider\/index\.js['"]/);
    expect(typesText).toMatch(/schema:\s*JSONSchema7/);
  });

  it('Tools types imports JSONSchema7 for schema-bearing signatures', () => {
    const typesText = fs.readFileSync(
      path.join(srcRoot, 'foundation', 'tools', 'types.ts'),
      'utf8',
    );
    expect(typesText).toMatch(/import\s+type\s+\{\s*JSONSchema7\s*\}\s+from\s+['"]\.\.\/llm-provider\/index\.js['"]/);
    expect(typesText).toMatch(/input_schema:\s*JSONSchema7/);
    expect(typesText).toMatch(/getToolSchema\?\(name:\s*string\):\s*JSONSchema7\s*\|\s*undefined/);
  });
});
