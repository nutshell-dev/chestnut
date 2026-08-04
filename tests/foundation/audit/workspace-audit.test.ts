/**
 * Phase 1288 Step C: createWorkspaceAudit — workspace 根审计唯一生产构造入口
 *
 * IO 级验收：
 * - 新根事件真实落 `.chestnut/audit/audit.tsv`（AUDIT_PATHS.audit）；
 * - legacy 根 `.chestnut/audit.tsv` 不新增（不存在则不创建；已存在则内容原样）；
 * - retention 自 AuditLog 自家 config store 读取：missing → null（不 rotation）；
 *   已配置 max_size_mb → rotation 生效；invalid → 构造 throw（fail-loud）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  createWorkspaceAudit,
  initWorkspaceAuditConfig,
  AUDIT_PATHS,
  AUDIT_LEGACY_PATHS,
} from '../../../src/foundation/audit/index.js';
import { createTrackedTempDirSync } from '../../utils/temp.js';

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

describe('phase 1288 Step C: createWorkspaceAudit', () => {
  let chestnutRoot: string;

  beforeEach(() => {
    chestnutRoot = createTrackedTempDirSync('workspace-audit-');
  });

  afterEach(() => {
    fs.rmSync(chestnutRoot, { recursive: true, force: true });
  });

  const newAuditPath = () => path.join(chestnutRoot, AUDIT_PATHS.audit);
  const legacyAuditPath = () => path.join(chestnutRoot, AUDIT_LEGACY_PATHS.audit);

  function writeConfigWithRetention(maxSizeMb: number | null): void {
    fs.mkdirSync(path.join(chestnutRoot, AUDIT_PATHS.root), { recursive: true });
    fs.writeFileSync(
      path.join(chestnutRoot, AUDIT_PATHS.config),
      `schema_version: 1\nretention:\n  max_size_mb: ${maxSizeMb === null ? 'null' : maxSizeMb}\n`,
    );
  }

  it('事件真实落 audit/audit.tsv；legacy 根 audit.tsv 不被创建', () => {
    const audit = createWorkspaceAudit(fsFactory, chestnutRoot);
    audit.write('watchdog_start', 'scope=test');

    expect(fs.existsSync(newAuditPath())).toBe(true);
    const content = fs.readFileSync(newAuditPath(), 'utf8');
    expect(content).toContain('watchdog_start');
    expect(content).toContain('scope=test');
    expect(fs.existsSync(legacyAuditPath())).toBe(false);
  });

  it('已存在的 legacy 根 audit.tsv 内容原样、不新增（两文件共同构成完整历史）', () => {
    const legacyLines = '2024-01-01T00:00:00Z\tseq=1\tlegacy_event\n';
    fs.writeFileSync(legacyAuditPath(), legacyLines);

    const audit = createWorkspaceAudit(fsFactory, chestnutRoot);
    audit.write('watchdog_start');

    expect(fs.readFileSync(legacyAuditPath(), 'utf8')).toBe(legacyLines);
    expect(fs.readFileSync(newAuditPath(), 'utf8')).toContain('watchdog_start');
  });

  it('config missing → retention null：构造与写入正常、不 rotation', () => {
    expect(fs.existsSync(path.join(chestnutRoot, AUDIT_PATHS.config))).toBe(false);
    const audit = createWorkspaceAudit(fsFactory, chestnutRoot);
    audit.write('event_a');
    audit.write('event_b');
    const content = fs.readFileSync(newAuditPath(), 'utf8');
    expect(content).toContain('event_a');
    expect(content).toContain('event_b');
  });

  it('config 已配置 max_size_mb → retention 生效（超阈值 rotation 落 .bak）', () => {
    writeConfigWithRetention(1); // 1 MB
    // 预置超阈值（>1MB）的既有 audit 数据
    fs.mkdirSync(path.join(chestnutRoot, AUDIT_PATHS.root), { recursive: true });
    fs.writeFileSync(newAuditPath(), 'x'.repeat(1024 * 1024 + 1));

    const audit = createWorkspaceAudit(fsFactory, chestnutRoot);
    audit.write('post_rotation_event');

    const auditDir = path.join(chestnutRoot, AUDIT_PATHS.root);
    const baks = fs.readdirSync(auditDir).filter((n) => n.startsWith('audit.tsv.') && n.endsWith('.bak'));
    expect(baks).toHaveLength(1);
    expect(fs.statSync(path.join(auditDir, baks[0])).size).toBeGreaterThan(1024 * 1024);
    const fresh = fs.readFileSync(newAuditPath(), 'utf8');
    expect(fresh).toContain('post_rotation_event');
    expect(fresh.length).toBeLessThan(1024);
  });

  it('config invalid → 构造 throw（fail-loud，不静默降级 legacy）', () => {
    fs.mkdirSync(path.join(chestnutRoot, AUDIT_PATHS.root), { recursive: true });
    fs.writeFileSync(path.join(chestnutRoot, AUDIT_PATHS.config), 'retention: [unclosed\n');

    expect(() => createWorkspaceAudit(fsFactory, chestnutRoot)).toThrow(/Invalid workspace audit config/);
    expect(fs.existsSync(newAuditPath())).toBe(false);
    expect(fs.existsSync(legacyAuditPath())).toBe(false);
  });

  it('init 默认配置（max_size_mb null）→ 构造正常、写新路径', () => {
    initWorkspaceAuditConfig(fsFactory(chestnutRoot));
    const audit = createWorkspaceAudit(fsFactory, chestnutRoot);
    audit.write('event_after_init');
    expect(fs.readFileSync(newAuditPath(), 'utf8')).toContain('event_after_init');
    expect(fs.existsSync(legacyAuditPath())).toBe(false);
  });
});
