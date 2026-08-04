/**
 * Phase 1288 Step B: Assembly 侧 legacy root YAML `audit:` 段原语。
 *
 * 覆盖：
 * - readLegacyAuditConfigSection：无文件/无段 → undefined；有段 → typed AuditConfig +
 *   稳定 sourceHash（同内容同 hash、异内容异 hash）；段 invalid → throw；YAML 坏 → throw。
 * - removeLegacyAuditConfigSection：raw patch 删除 audit 段 + 回读校验；
 *   未知/非 audit 字段逐字节语义保持（值、类型、未写字段不被 schema default 注入）；
 *   段不存在 → 幂等 no-op。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import {
  readLegacyAuditConfigSection,
  removeLegacyAuditConfigSection,
} from '../../src/assembly/config/config-load.js';
import { createTrackedTempDirSync } from '../utils/temp.js';

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });
const deps = { fsFactory };

const ROOT_YAML = `version: '1'
custom_unknown_field: keep-me
llm:
  primary:
    preset: anthropic
    api_key: \${CHESTNUT_TEST_UNUSED_KEY}
    model: claude-sonnet-4-5
audit:
  retention:
    max_size_mb: 32
motion:
  heartbeat_interval_ms: 0
`;

describe('phase 1288 Step B: Assembly legacy audit section primitives', () => {
  let workspaceRoot: string;
  let configPath: string;

  beforeEach(() => {
    workspaceRoot = createTrackedTempDirSync('legacy-audit-section-');
    fs.mkdirSync(path.join(workspaceRoot, '.chestnut'), { recursive: true });
    configPath = path.join(workspaceRoot, '.chestnut', 'config.yaml');
    vi.stubEnv('CHESTNUT_ROOT', workspaceRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function writeRootYaml(content: string): void {
    fs.writeFileSync(configPath, content);
  }

  describe('readLegacyAuditConfigSection', () => {
    it('config.yaml 不存在 → undefined', () => {
      expect(readLegacyAuditConfigSection(deps)).toBeUndefined();
    });

    it('无 audit 段 → undefined', () => {
      writeRootYaml("version: '1'\ncustom_unknown_field: keep-me\n");
      expect(readLegacyAuditConfigSection(deps)).toBeUndefined();
    });

    it('有 audit 段 → typed AuditConfig + sha256 sourceHash；同内容 hash 稳定、异内容 hash 不同', () => {
      writeRootYaml(ROOT_YAML);
      const first = readLegacyAuditConfigSection(deps);
      expect(first?.config).toEqual({ retention: { max_size_mb: 32 } });
      expect(first?.sourceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(readLegacyAuditConfigSection(deps)?.sourceHash).toBe(first?.sourceHash);

      writeRootYaml(ROOT_YAML.replace('max_size_mb: 32', 'max_size_mb: 64'));
      const second = readLegacyAuditConfigSection(deps);
      expect(second?.config).toEqual({ retention: { max_size_mb: 64 } });
      expect(second?.sourceHash).not.toBe(first?.sourceHash);
    });

    it('audit 段为空对象 → schema default 填 max_size_mb: null', () => {
      writeRootYaml("version: '1'\naudit: {}\n");
      expect(readLegacyAuditConfigSection(deps)?.config).toEqual({ retention: { max_size_mb: null } });
    });

    it('audit 段 invalid → throw（fail-loud，不静默迁移坏配置）', () => {
      writeRootYaml('audit:\n  retention:\n    max_size_mb: 0\n');
      expect(() => readLegacyAuditConfigSection(deps)).toThrow(/legacy audit section/);
    });

    it('root YAML 语法坏 → throw', () => {
      writeRootYaml('audit: [unclosed\n');
      expect(() => readLegacyAuditConfigSection(deps)).toThrow(/Invalid YAML/);
    });
  });

  describe('removeLegacyAuditConfigSection', () => {
    it('删除 audit 段；未知/非 audit 字段逐字节语义保持、无 schema default 注入', () => {
      writeRootYaml(ROOT_YAML);
      removeLegacyAuditConfigSection(deps);

      const afterText = fs.readFileSync(configPath, 'utf8');
      const after = yaml.load(afterText) as Record<string, unknown>;
      const before = yaml.load(ROOT_YAML) as Record<string, unknown>;
      delete before.audit;
      // 语义全等（未知字段 custom_unknown_field、${ENV} 字面、number/string 类型全保持）
      expect(after).toEqual(before);
      // 无 schema round-trip：未写的 owner 段不得被 default 注入
      for (const key of ['watchdog', 'cron', 'viewport', 'stream', 'tool_timeout_ms', 'default_max_steps']) {
        expect(after[key], `${key} must not be default-injected`).toBeUndefined();
      }
      // 旧字段原样（字符串保持 string、不被强转）
      expect(after.version).toBe('1');
      expect((after.llm as any).primary.api_key).toBe('${CHESTNUT_TEST_UNUSED_KEY}');
    });

    it('audit 段不存在 → 幂等 no-op，文件语义不变', () => {
      const content = "version: '1'\ncustom_unknown_field: keep-me\n";
      writeRootYaml(content);
      removeLegacyAuditConfigSection(deps);
      expect(yaml.load(fs.readFileSync(configPath, 'utf8'))).toEqual(yaml.load(content));
    });

    it('回读校验：删除后 readLegacyAuditConfigSection 返回 undefined', () => {
      writeRootYaml(ROOT_YAML);
      removeLegacyAuditConfigSection(deps);
      expect(readLegacyAuditConfigSection(deps)).toBeUndefined();
    });
  });
});
