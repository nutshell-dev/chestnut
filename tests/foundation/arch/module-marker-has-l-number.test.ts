import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * phase 501: ratchet test ensuring every @module marker in src/ has L number.
 *
 * phase 441 closed 6 floating @module files (e.g. "@module Core.ClawId"
 * without L number). This test prevents future regression: any new
 * "@module X.Y.Z" without L<number>. will fail this test.
 *
 * If a new module wants @module, it must have form "@module L<n>.Name..."
 */
describe('@module marker has L number ratchet (phase 501)', () => {
  it('all @module markers in src/ contain L<number>', () => {
    const srcRoot = path.join(__dirname, '..', '..', '..', 'src');
    // Find @module followed by anything that is NOT L<digit>
    const cmd = `grep -rn "@module " ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const lines = out.trim().split('\n').filter(Boolean);
    const floating = lines.filter(line => {
      // Extract the @module marker payload
      const match = line.match(/@module\s+(.+)$/);
      if (!match) return false;
      const payload = match[1].trim();
      // Allowed: starts with L<digit> optionally followed by anything
      if (/^L\d+/.test(payload)) return false;
      return true;
    });
    expect(floating).toEqual([]);
  });
});
