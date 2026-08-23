import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, '..', '..', '..', 'src');

/**
 * phase 1492 Step D: ToolUseId identity protocol owner boundary ratchet.
 *
 * ToolUseId type + makeToolUseId factory are owned by LLMProvider (L1).
 * ToolProtocol (L2b) no longer re-exports them; JSONSchema7 compatibility
 * surface remains on ToolProtocol.
 */
describe('ToolUseId owner boundary ratchet (phase 1492)', () => {
  /**
   * Parse each import declaration in src/.../*.ts files and assert no
   * declaration imports ToolUseId or makeToolUseId from the ToolProtocol barrel.
   */
  it('no src file imports ToolUseId/makeToolUseId from tool-protocol barrel', () => {
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
        // tool-protocol/index.js. `[^}]*` keeps the match inside one brace pair,
        // preventing cross-import false positives; default/namespace imports are
        // irrelevant for this ratchet.
        const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]*tool-protocol\/index\.js)['"];?/g;
        let m: RegExpExecArray | null;
        while ((m = importRe.exec(text)) !== null) {
          const braceContent = m[1];
          if (/\b(ToolUseId|makeToolUseId)\b/.test(braceContent)) {
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
   * Forward assertions: owner barrel still exports the identity protocol.
   */
  it('LLMProvider barrel exports makeToolUseId factory and ToolUseId type', async () => {
    const llmProvider = await import('../../../src/foundation/llm-provider/index.js');
    expect(typeof llmProvider.makeToolUseId).toBe('function');

    const barrelText = fs.readFileSync(
      path.join(srcRoot, 'foundation', 'llm-provider', 'index.ts'),
      'utf8',
    );
    expect(barrelText).toMatch(/export\s+type\s+\{\s*ToolUseId\s*\}/);
    expect(barrelText).toMatch(/export\s+\{\s*makeToolUseId\s*\}/);
  });

  /**
   * Backward assertions: ToolProtocol barrel retains JSONSchema7 but not the
   * retired identity protocol re-exports.
   */
  it('ToolProtocol barrel retains JSONSchema7 and drops ToolUseId/makeToolUseId', () => {
    const barrelText = fs.readFileSync(
      path.join(srcRoot, 'foundation', 'tool-protocol', 'index.ts'),
      'utf8',
    );
    expect(barrelText).toMatch(/JSONSchema7/);
    expect(barrelText).not.toMatch(/\bToolUseId\b/);
    expect(barrelText).not.toMatch(/\bmakeToolUseId\b/);
  });
});
