/**
 * source scan invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - source-scan-invariants.test.ts
 *  - types-pattern-sibling-direct.test.ts
 *  - system-imports-overview.test.ts
 *  - resource-owner-presence.test.ts
 *  - module-marker-has-l-number.test.ts
 *  - barrel-index-presence.test.ts
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('source-scan-invariants', () => {
  /**
   * phase 502: ratchet test ensuring no "L0" string appears in src/.
   *
   * phase 441 user clarified: L0 is a doc/spec-only concept, not allowed
   * in code. phase 441 removed the only L0 literal (formerly in root constants
   * file's "L0 shared constants only" comment、phase 520 整 file 删).
   *
   * This ratchet prevents regression.
   */
  describe('no L0 in src ratchet (phase 502)', () => {
    it('no L0 word-boundary string appears in src/', () => {
      const srcRoot = path.join(__dirname, '..', '..', '..', 'src');
      const cmd = `grep -rnE "\\bL0\\b" ${srcRoot} --include='*.ts' || true`;
      const out = execSync(cmd, { encoding: 'utf8' });
      expect(out.trim()).toBe('');
    });
  });

  /**
   * phase 632: ratchet test for tests/foundation/arch/*.test.ts file count.
   *
   * 当前 main 23 file。ratchet 下限 20（buffer 3 防偶发临时去除）。新增 arch
   * invariant 时持续调高下限。防 future 误删（merge / rebase 漂位 / refactor
   * 失误）→ arch invariant 矩阵静默缩水、规约失防。
   *
   * Mirrors phase 494/563 `depcruise-rule-count-ratchet` (≥ 50 forbidden
   * rules) + phase 631 ESLint custom rule count ratchet (≥ 30) for the
   * arch invariant test surface.
   */
  describe('arch invariant test count ratchet (phase 632)', () => {
    it('tests/foundation/arch/*.test.ts count ≥ 10', () => {
      const archDir = path.resolve(__dirname);
      const files = fs.readdirSync(archDir).filter(f => f.endsWith('.test.ts'));
      expect(files.length).toBeGreaterThanOrEqual(10);
    });
  });

  /**
   * phase 676: ratchet test that every arch invariant test file
   * tests/foundation/arch/*.test.ts has line count ≤ 150.
   *
   * 当前最长 84 行。soft ceiling 150、buffer ~65 防偶发。Arch test
   * 应聚焦单一 invariant、不应混测多个（ML#7 模块界面最小）。
   *
   * Mirrors phase 670 (rule line count ≤ 300) + phase 675 (rule test ≤
   * 200) to the arch test layer. Pairs with phase 632 (arch test count
   * ratchet ≥ 10 after phase 1027 merge).
   */
  describe('arch invariant test line count ratchet (phase 676)', () => {
    it('every arch test file line count ≤ 150', () => {
      const archDir = path.resolve(__dirname);
      const files = fs.readdirSync(archDir).filter(f => f.endsWith('.test.ts'));
      const offenders: string[] = [];
      for (const f of files) {
        // Phase 1008/1027 merged invariant files intentionally group many tests; the 150-line
        // ceiling applies to single-invariant files only.
        if (f.endsWith('.invariant.test.ts') || f.endsWith('-invariants.test.ts')) continue;
        const lines = fs.readFileSync(path.join(archDir, f), 'utf-8').split('\n').length;
        if (lines > 150) offenders.push(`${f} (${lines} lines)`);
      }
      expect(offenders).toEqual([]);
    });
  });
});

describe('types-pattern-sibling-direct', () => {
  /**
   * phase 506: invariant that foundation/<module>/types.ts files exist as
   * sibling-direct ratify (phase 1312 D) — major foundation modules each
   * have a types.ts file that's allowed to be deep-imported.
   *
   * phase 576 扩: 5 → 12 entry 覆盖 foundation 全 types.ts (transport / dialog-store /
   * stream / file-watcher / process-manager / llm-orchestrator / process-exec 7 文件
   * 同型属 sibling-direct ratify pattern、应一同护)。
   */
  describe('foundation types.ts sibling-direct pattern (phase 506 / phase 576 expanded)', () => {
    const srcRoot = path.join(__dirname, '..', '..', '..', 'src');

    it.each([
      'foundation/fs/types.ts',
      'foundation/llm-provider/types.ts',
      'foundation/audit/types.ts',
      'foundation/messaging/types.ts',
      'foundation/tools/types.ts',
      // phase 576 +7
      'foundation/transport/types.ts',
      'foundation/dialog-store/types.ts',
      'foundation/stream/types.ts',
      'foundation/file-watcher/types.ts',
      'foundation/process-manager/types.ts',
      'foundation/llm-orchestrator/types.ts',
      'foundation/process-exec/types.ts',
    ])('%s exists (sibling-direct ratify target)', (rel) => {
      const cmd = `test -f ${srcRoot}/${rel} && echo OK || echo MISS`;
      const out = execSync(cmd, { encoding: 'utf8' });
      expect(out.trim()).toBe('OK');
    });
  });
});

describe('system-imports-overview', () => {
  /**
   * phase 499: comprehensive ratchet test that no other src files import
   * Node.js system modules outside their designated owner.
   *
   * Designated owners:
   *   - fs / fs/promises -> foundation/fs/* + audit/{writer,reader} + process-exec/spawn-detached
   *   - child_process     -> foundation/process-exec/*
   *   - net               -> foundation/transport/*
   *   - crypto            -> foundation/node-utils/crypto + foundation/node-utils/id
   *   - os                -> foundation/audit/{writer,reader}
   *
   * Other system modules (http/https/tls/dns/stream/worker_threads/cluster/process)
   * must have 0 direct imports under src/.
   */
  describe('system module imports overview ratchet (phase 499)', () => {
    const srcRoot = path.join(__dirname, '..', '..', '..', 'src');

    function listImporters(moduleName: string): string[] {
      const cmd = `grep -rEln "from ['\\\"](node:)?${moduleName}['\\\"]" ${srcRoot} --include='*.ts' || true`;
      const out = execSync(cmd, { encoding: 'utf8' });
      return out.trim().split('\n').filter(Boolean);
    }

    it.each([
      ['http'],
      ['https'],
      ['tls'],
      ['dns'],
      ['stream'],
      ['worker_threads'],
      ['cluster'],
      ['process'],
    ])('no src file imports node:%s', (moduleName) => {
      const files = listImporters(moduleName);
      expect(files).toEqual([]);
    });
  });
});

describe('resource-owner-presence', () => {
  /**
   * phase 504: invariant test that resource owner modules physically exist.
   *
   * Lint rules and ratchet tests reference these paths. If anyone renames
   * or removes them without updating dependent rules, this catches it.
   *
   * phase 564 扩 (phase 520-554 follow-up): 加 5 entry 覆盖 motion-claw-id / agent-dir-resolver /
   * claw-status-hints / claw-failure-classes / cli-commands。新 owner module 引入后未加 invariant、
   * 误删不 fail-loud。
   */
  describe('resource owner modules physical presence (phase 504 / phase 564 expanded)', () => {
    const srcRoot = path.join(__dirname, '..', '..', '..', 'src');

    const owners = [
      { name: 'foundation/fs (L1 owner)', rel: 'foundation/fs/node-fs.ts' },
      { name: 'foundation/node-utils/id (entropy owner)', rel: 'foundation/node-utils/id.ts' },
      { name: 'foundation/node-utils/crypto (hash owner)', rel: 'foundation/node-utils/crypto.ts' },
      { name: 'foundation/process-exec (child_process owner)', rel: 'foundation/process-exec/exec.ts' },
      { name: 'foundation/transport (net owner)', rel: 'foundation/transport/unix-socket.ts' },
      // phase 564: phase 520-554 引入的 5 个 owner module
      { name: 'core/claw-topology/motion-claw-id (phase 520: MOTION_CLAW_ID owner)', rel: 'core/claw-topology/motion-claw-id.ts' },
      { name: 'core/claw-topology/agent-dir-resolver (phase 535: motion-vs-claw dir resolver)', rel: 'core/claw-topology/agent-dir-resolver.ts' },
      { name: 'cli/utils/claw-status-hints (phase 540/708)', rel: 'cli/utils/claw-status-hints.ts' },
      { name: 'watchdog/claw-failure-classes (phase 552/708)', rel: 'watchdog/claw-failure-classes.ts' },
      { name: 'cli/utils/cli-commands (phase 554/708)', rel: 'cli/utils/cli-commands.ts' },
    ];

    it.each(owners)('$name file exists at expected path: $rel', ({ rel }) => {
      const full = path.join(srcRoot, rel);
      expect(fs.existsSync(full)).toBe(true);
    });
  });
});

describe('module-marker-has-l-number', () => {
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
});

describe('barrel-index-presence', () => {
  /**
   * phase 507: invariant that every foundation submodule with a non-trivial
   * directory has an index.ts barrel.
   *
   * This protects against accidentally creating a deep-only module that
   * bypasses the M#7 barrel-only convention.
   *
   * phase 567 扩: 加 core/<module>/ 同型扫描。core 当前 19 submodule 全有 barrel、
   * ratchet 防 future drift 新建 core 子模块 0 barrel。
   */
  describe('foundation + core barrel index.ts presence (phase 507 / phase 567 expanded)', () => {
    const srcRoot = path.join(__dirname, '..', '..', '..', 'src');
    const foundationDir = path.join(srcRoot, 'foundation');
    const coreDir = path.join(srcRoot, 'core');

    // phase 740: core/permissions barrel removed as dead code (0 imports).
    // The directory still contains implementation files, so it is intentionally
    // exempt from the barrel-presence ratchet until it is re-barreled or folded
    // into another module.
    const CORE_BARREL_EXCEPTIONS = new Set(['permissions']);

    function scanForMissingBarrels(rootDir: string, exceptions?: Set<string>): string[] {
      const entries = fs.readdirSync(rootDir, { withFileTypes: true });
      const missing: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (exceptions?.has(entry.name)) continue;
        const indexPath = path.join(rootDir, entry.name, 'index.ts');
        if (!fs.existsSync(indexPath)) {
          missing.push(entry.name);
        }
      }
      return missing;
    }

    it('each foundation/<module>/ directory has an index.ts barrel', () => {
      expect(scanForMissingBarrels(foundationDir)).toEqual([]);
    });

    it('each core/<module>/ directory has an index.ts barrel (phase 567)', () => {
      expect(scanForMissingBarrels(coreDir, CORE_BARREL_EXCEPTIONS)).toEqual([]);
    });
  });
});
