/**
 * Phase 1288 Step D: legacy 根 audit 只读与 segments 边界 ratchet。
 * （自 audit-layout-boundary.test.ts 拆出、Phase 1292 Step B）
 *
 * 冻结：
 *  - 目标 writer 唯一：AUDIT_PATHS.audit 引用白名单恰三处，构造点收敛 factory.ts
 *    （workspace-audit.ts 通过 createSystemAudit 委托 factory）；
 *  - legacy 根 audit.tsv 只读：AUDIT_LEGACY_PATHS.audit 引用白名单恰两处、
 *    零写/删/移/改名操作；
 *  - 其他 scope（motion/claw/tick/viewport）审计路径零迁移、值保持原值；
 *  - legacy 写操作 scanner 正反 fixture 自证。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assemblyDir, walkTsFiles } from './cli-guidance-boundary-helpers.js';

const SRC_ROOT = path.join(assemblyDir(), '..');
const PROJECT_ROOT = path.join(SRC_ROOT, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const AUDIT_DIR = path.join(SRC_ROOT, 'foundation', 'audit');

describe('phase 1288 Step D: legacy 根 audit 只读与 segments 边界 ratchet', () => {
  // legacy/目标数据路径引用白名单（校准而非删除所有权语义）：
  //  - workspace-audit.ts   唯一生产写 audit/audit.tsv（createWorkspaceAudit）
  //  - workspace-segments.ts 唯一 segments 读取消费方（legacy/new 双段、只读）
  //  - motion-addons.ts     monitor 三段常驻观察装配（stat 观察、不写）
  const TARGET_AUDIT_REF_FILES = [
    'src/foundation/audit/workspace-audit.ts',
    'src/foundation/audit/workspace-segments.ts',
    'src/assembly/motion-addons.ts',
  ];
  const LEGACY_AUDIT_REF_FILES = [
    'src/foundation/audit/workspace-segments.ts',
    'src/assembly/motion-addons.ts',
  ];
  const MUTATION_TOKENS = [
    'writeSync(', 'writeFileSync(', 'appendSync(', 'appendFileSync(',
    'renameSync(', 'moveSync(', 'rmSync(', 'unlinkSync(', 'writeAtomicSync(', 'removeSync(',
  ];

  function filesReferencing(token: string, dir: string): string[] {
    return walkTsFiles(dir)
      .filter((f) => fs.readFileSync(f, 'utf8').includes(token))
      .map((f) => path.relative(PROJECT_ROOT, f));
  }

  function mutationTokensIn(rel: string): string[] {
    const text = fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8');
    return MUTATION_TOKENS.filter((t) => text.includes(t));
  }

  it('目标 writer 唯一：AUDIT_PATHS.audit 引用白名单恰三处、构造点收敛 factory.ts', () => {
    expect(filesReferencing('AUDIT_PATHS.audit', SRC_ROOT).sort()).toEqual([...TARGET_AUDIT_REF_FILES].sort());
    const factoryText = fs.readFileSync(path.join(PROJECT_ROOT, 'src/foundation/audit/factory.ts'), 'utf8');
    expect(factoryText).toContain('new AuditWriter');
    expect(factoryText).toContain('new DispatchingAuditWriter');
    for (const rel of TARGET_AUDIT_REF_FILES) {
      const text = fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8');
      expect(text.includes('new AuditWriter'), `${rel} must not construct audit writers`).toBe(false);
      expect(text.includes('new DispatchingAuditWriter'), `${rel} must not construct audit writers`).toBe(false);
      if (rel.endsWith('workspace-audit.ts')) {
        expect(text).toContain('createSystemAudit');
      }
    }
  });

  it('legacy 根 audit.tsv 只读：AUDIT_LEGACY_PATHS.audit 引用白名单恰两处、零写/删/移/改名操作', () => {
    expect(filesReferencing('AUDIT_LEGACY_PATHS.audit', SRC_ROOT).sort()).toEqual([...LEGACY_AUDIT_REF_FILES].sort());
    for (const rel of LEGACY_AUDIT_REF_FILES) {
      expect(mutationTokensIn(rel), `${rel} must not mutate legacy audit`).toEqual([]);
    }
  });

  it('其他 scope（motion/claw/tick/viewport）审计路径零迁移、值保持原值', () => {
    const writer = fs.readFileSync(path.join(AUDIT_DIR, 'writer.ts'), 'utf8');
    expect(writer).toContain("export const AUDIT_FILE = 'audit.tsv';");
    const types = fs.readFileSync(path.join(AUDIT_DIR, 'types.ts'), 'utf8');
    expect(types).toContain("export type AuditFileName = 'audit' | 'tick' | 'viewport';");
    // motion audit 主观察路径保持 motion/audit.tsv
    const addons = fs.readFileSync(path.join(PROJECT_ROOT, 'src/assembly/motion-addons.ts'), 'utf8');
    expect(addons).toContain("primaryAuditPath: path.join(chestnutRoot, 'motion', AUDIT_FILE)");
    // tick 分流保持原值（daemon liveness / eventloop iteration → tick.tsv）
    const daemonEvents = fs.readFileSync(path.join(PROJECT_ROOT, 'src/daemon/audit-events.ts'), 'utf8');
    expect(daemonEvents).toContain("daemon_liveness_heartbeat: 'tick'");
    const eventloopEvents = fs.readFileSync(path.join(PROJECT_ROOT, 'src/core/event-loop/audit-events.ts'), 'utf8');
    expect(eventloopEvents).toContain("eventloop_iteration: 'tick'");
    // viewport 分流保持原值
    const viewportEvents = fs.readFileSync(path.join(PROJECT_ROOT, 'src/cli/commands/viewport-audit-events.ts'), 'utf8');
    expect(viewportEvents).toContain("'viewport'");
  });

  it('legacy 写操作 scanner 正反 fixture 自证', () => {
    const refs = filesReferencing('AUDIT_LEGACY_PATHS.audit', FIXTURES_DIR);
    const violation = refs.find((f) => f.includes('audit-legacy-write-violation'));
    expect(violation).toBeDefined();
    expect(mutationTokensIn(violation!)).toContain('appendFileSync(');
    const clean = refs.find((f) => f.includes('audit-legacy-readonly-clean'));
    expect(clean).toBeDefined();
    expect(mutationTokensIn(clean!)).toEqual([]);
  });
});
