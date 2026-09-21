import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 1247 Step E ratchet: CLI supervision policy coverage.
 *
 * - Every Commander `.action(...)` registration in src/cli must go through the
 *   supervision-policy wrapper (`action` / `cliAction` / `verbAction` /
 *   `deferredRequiredAction` / `cliDeferredRequiredAction`).
 * - `ensureWatchdog` must only appear inside `src/cli/supervision-policy.ts`;
 *   no other CLI module is allowed to reach into Watchdog internals.
 * - phase 1280: `start.ts` 不得直依赖 Watchdog——监督能力由 deferred wrapper
 *   以 ensureSupervision capability 注入。
 */
describe('CLI supervision policy coverage ratchet (phase 1247)', () => {
  const projectRoot = path.join(__dirname, '..', '..', '..');
  const cliDir = path.join(projectRoot, 'src', 'cli');

  function listCliTsFiles(): string[] {
    const files: string[] = [];
    function walk(current: string) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          files.push(full);
        }
      }
    }
    walk(cliDir);
    return files;
  }

  function relativePath(full: string): string {
    return path.relative(projectRoot, full);
  }

  it('every .action registration is wrapped by the supervision-policy helper', () => {
    const violations: string[] = [];
    const allowedWrappers = new Set(['action', 'cliAction', 'verbAction', 'deferredRequiredAction', 'cliDeferredRequiredAction']);

    for (const file of listCliTsFiles()) {
      const content = fs.readFileSync(file, 'utf-8');
      // Match `.action( <identifier>( ... )` with optional whitespace/newlines.
      const regex = /\.action\s*\(\s*(\w+)\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const wrapper = match[1];
        if (!allowedWrappers.has(wrapper)) {
          const lines = content.slice(0, match.index).split('\n');
          const line = lines.length;
          violations.push(`${relativePath(file)}:${line}: .action(${wrapper}(...)`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('ensureWatchdog is only referenced in supervision-policy.ts', () => {
    const violations: string[] = [];
    const allowedFile = path.join(cliDir, 'supervision-policy.ts');

    for (const file of listCliTsFiles()) {
      if (file === allowedFile) continue;
      const content = fs.readFileSync(file, 'utf-8');
      // phase 1890 Step J：迁移编排已删，ensureWatchdog 仅 supervision-policy.ts 可引用。
      if (/\bensureWatchdog\b/.test(content)) {
        violations.push(relativePath(file));
      }
    }

    expect(violations).toEqual([]);
  });

  it('claw router wraps the list path with supervision policy', () => {
    const routerPath = path.join(cliDir, 'commands', 'claw-router.ts');
    const content = fs.readFileSync(routerPath, 'utf-8');
    expect(content).toMatch(/verbAction\('observe_only',\s*\(\)\s*=>\s*listCommand\(/);
  });

  it('start command does not depend on Watchdog directly (phase 1280)', () => {
    const startPath = path.join(cliDir, 'commands', 'start.ts');
    const content = fs.readFileSync(startPath, 'utf-8');
    // phase 1890 Step J：同层迁移编排特许随删除回收；start.ts 零 watchdog 引用。
    // 禁止的是直依赖 Watchdog daemon/监督模块（watchdog/ 深链与 ensureWatchdog 原语）。
    expect(content).not.toMatch(/from\s+['"][^'"]*watchdog[^'"]*['"]/);
    expect(content).not.toMatch(/\bensureWatchdog\b/);
  });
});
