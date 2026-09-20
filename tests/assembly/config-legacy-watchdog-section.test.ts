/**
 * Phase 1289 Step B: Assembly 侧 legacy root YAML `watchdog:` 段原语。
 *
 * 覆盖：
 * - readLegacyWatchdogConfigSection：无文件/无段 → undefined；有段 → typed WatchdogConfig +
 *   稳定 sourceHash（同内容同 hash、异内容异 hash）；log_archive_days 捕获进 retired
 *   （含/不含两态，不进入 typed config）；段 invalid → throw；YAML 坏 → throw。
 * - removeLegacyWatchdogConfigSection：raw patch 删除 watchdog 段 + 回读校验；
 *   未知/非 watchdog 字段逐字节语义保持（值、类型、未写字段不被 schema default 注入）；
 *   段不存在 → 幂等 no-op。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import {
  readLegacyWatchdogConfigSection,
  removeLegacyWatchdogConfigSection,
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
watchdog:
  interval_ms: 60000
  disk_warning_mb: 1024
  log_archive_days: 30
  claw_inactivity_timeout_ms: 600000
motion:
  heartbeat_interval_ms: 0
`;

describe('phase 1289 Step B: Assembly legacy watchdog section primitives', () => {
  let workspaceRoot: string;
  let configPath: string;

  beforeEach(() => {
    workspaceRoot = createTrackedTempDirSync('legacy-watchdog-section-');
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

  describe('readLegacyWatchdogConfigSection', () => {
    it('config.yaml 不存在 → undefined', () => {
      expect(readLegacyWatchdogConfigSection(deps)).toBeUndefined();
    });

    it('无 watchdog 段 → undefined', () => {
      writeRootYaml("version: '1'\ncustom_unknown_field: keep-me\n");
      expect(readLegacyWatchdogConfigSection(deps)).toBeUndefined();
    });

    it('有 watchdog 段 → typed WatchdogConfig + sha256 sourceHash；同内容 hash 稳定、异内容 hash 不同', () => {
      writeRootYaml(ROOT_YAML);
      const first = readLegacyWatchdogConfigSection(deps);
      // Phase 1878 Step C：disk_warning_mb / claw_inactivity_timeout_ms 已退役，
      // 不进 typed config（下方 retired 捕获留证）；heartbeat_stale_timeout_ms 取默认。
      expect(first?.config).toEqual({
        interval_ms: 60000,
        heartbeat_stale_timeout_ms: 180000,
      });
      expect(first?.sourceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(readLegacyWatchdogConfigSection(deps)?.sourceHash).toBe(first?.sourceHash);

      writeRootYaml(ROOT_YAML.replace('interval_ms: 60000', 'interval_ms: 90000'));
      const second = readLegacyWatchdogConfigSection(deps);
      expect(second?.config.interval_ms).toBe(90000);
      expect(second?.sourceHash).not.toBe(first?.sourceHash);
    });

    it('已退役字段为 number → 捕获进 retired 留证，不进入 typed config', () => {
      writeRootYaml(ROOT_YAML);
      const section = readLegacyWatchdogConfigSection(deps);
      expect(section?.retired).toEqual({
        log_archive_days: 30,
        disk_warning_mb: 1024,
        claw_inactivity_timeout_ms: 600000,
      });
      expect(section?.config).not.toHaveProperty('log_archive_days');
      expect(section?.config).not.toHaveProperty('disk_warning_mb');
      expect(section?.config).not.toHaveProperty('claw_inactivity_timeout_ms');
    });

    it('无退役字段 → retired 为空对象', () => {
      writeRootYaml(
        ROOT_YAML
          .replace('  log_archive_days: 30\n', '')
          .replace('  disk_warning_mb: 1024\n', '')
          .replace('  claw_inactivity_timeout_ms: 600000\n', ''),
      );
      const section = readLegacyWatchdogConfigSection(deps);
      expect(section?.retired).toEqual({});
    });

    it('watchdog 段为空对象 → schema default 填齐当前字段', () => {
      writeRootYaml("version: '1'\nwatchdog: {}\n");
      expect(readLegacyWatchdogConfigSection(deps)?.config).toEqual({
        interval_ms: 30000,
        heartbeat_stale_timeout_ms: 180000,
      });
    });

    it('watchdog 段 invalid → throw（fail-loud，不静默迁移坏配置）', () => {
      writeRootYaml('watchdog:\n  interval_ms: 100\n');
      expect(() => readLegacyWatchdogConfigSection(deps)).toThrow(/legacy watchdog section/);
    });

    it('root YAML 语法坏 → throw', () => {
      writeRootYaml('watchdog: [unclosed\n');
      expect(() => readLegacyWatchdogConfigSection(deps)).toThrow(/Invalid YAML/);
    });
  });

  describe('removeLegacyWatchdogConfigSection', () => {
    it('删除 watchdog 段；未知/非 watchdog 字段逐字节语义保持、无 schema default 注入', () => {
      writeRootYaml(ROOT_YAML);
      removeLegacyWatchdogConfigSection(deps);

      const afterText = fs.readFileSync(configPath, 'utf8');
      const after = yaml.load(afterText) as Record<string, unknown>;
      const before = yaml.load(ROOT_YAML) as Record<string, unknown>;
      delete before.watchdog;
      // 语义全等（未知字段 custom_unknown_field、${ENV} 字面、number/string 类型全保持）
      expect(after).toEqual(before);
      // 无 schema round-trip：未写的 owner 段不得被 default 注入
      for (const key of ['audit', 'cron', 'viewport', 'stream', 'tool_timeout_ms', 'default_max_steps']) {
        expect(after[key], `${key} must not be default-injected`).toBeUndefined();
      }
      // 旧字段原样（字符串保持 string、不被强转）
      expect(after.version).toBe('1');
      expect((after.llm as any).primary.api_key).toBe('${CHESTNUT_TEST_UNUSED_KEY}');
    });

    it('watchdog 段不存在 → 幂等 no-op，文件语义不变', () => {
      const content = "version: '1'\ncustom_unknown_field: keep-me\n";
      writeRootYaml(content);
      removeLegacyWatchdogConfigSection(deps);
      expect(yaml.load(fs.readFileSync(configPath, 'utf8'))).toEqual(yaml.load(content));
    });

    it('回读校验：删除后 readLegacyWatchdogConfigSection 返回 undefined', () => {
      writeRootYaml(ROOT_YAML);
      removeLegacyWatchdogConfigSection(deps);
      expect(readLegacyWatchdogConfigSection(deps)).toBeUndefined();
    });
  });
});
