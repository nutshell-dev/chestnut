/**
 * Phase 1910 Step E — claw create 独占创建点（RACE-CLAW-CREATE-CHECK-THEN-CREATE）
 *
 * 覆盖：
 * - 同名并发双 create：恰好一个 winner 成功 + audit；loser CliError already-exists，
 *   winner 的 config 不被覆盖；
 * - 崩溃窗口自愈：layout/AGENTS.md 已建、config 未发布 → create 冪等完成；
 * - config 已存在但模板缺失 → fail-closed already-exists，不覆盖 config、不补写模板；
 * - 正常创建回归：config + AGENTS.md + layout + audit 齐全。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import * as yaml from 'js-yaml';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createRootConfig } from '../../src/assembly/index.js';
import { CLAW_SPEC_FILE } from '../../src/foundation/claw-identity/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

const { createCommand } = await import('../../src/cli/commands/claw-create.js');

let tempDir: string;

function makeDeps() {
  return { fsFactory, rootConfig: createRootConfig({ fsFactory }) };
}

function clawRoot(name: string): string {
  return path.join(tempDir, '.chestnut', 'claws', name);
}

function configFile(name: string): string {
  return path.join(clawRoot(name), 'config.yaml');
}

function makeAudit() {
  const events: string[][] = [];
  const audit = {
    __brand: 'AuditLog' as const,
    write: vi.fn((...args: string[]) => { events.push(args); }),
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  } as unknown as import('../../src/foundation/audit/index.js').AuditLog;
  return { audit, events };
}

/** 最小 global config（create 前置 loadGlobal）。 */
function writeGlobalConfig(): void {
  const dir = path.join(tempDir, '.chestnut');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    `version: '1'\nllm:\n  primary:\n    preset: anthropic\n    api_key: sk-test\n    model: claude-test\n`,
  );
}

beforeEach(() => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tempDir = path.join(tmpdir(), `chestnut-claw-create-race-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  vi.stubEnv('CHESTNUT_ROOT', tempDir);
  writeGlobalConfig();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('claw create 独占创建点（Phase 1910 Step E）', () => {
  it('正常创建：config + AGENTS.md + audit 齐全', async () => {
    const { audit, events } = makeAudit();
    await createCommand(makeDeps(), 'alpha', { audit });

    const config = yaml.load(fs.readFileSync(configFile('alpha'), 'utf8')) as Record<string, unknown>;
    expect(config.name).toBe('alpha');
    expect(fs.existsSync(path.join(clawRoot('alpha'), CLAW_SPEC_FILE))).toBe(true);
    expect(events.filter(e => e[0] === 'cli_claw_create')).toHaveLength(1);
  });

  it('同名并发双 create：恰好一个 winner，loser already-exists，winner config 不被覆盖', async () => {
    const auditA = makeAudit();
    const auditB = makeAudit();

    const results = await Promise.allSettled([
      createCommand(makeDeps(), 'beta', { audit: auditA.audit }),
      createCommand(makeDeps(), 'beta', { audit: auditB.audit }),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already exists/);

    // 恰好一次创建 audit
    const totalAudit = [...auditA.events, ...auditB.events].filter(e => e[0] === 'cli_claw_create');
    expect(totalAudit).toHaveLength(1);

    // config 完好可读
    const config = yaml.load(fs.readFileSync(configFile('beta'), 'utf8')) as Record<string, unknown>;
    expect(config.name).toBe('beta');
  });

  it('顺序双 create：第二个 already-exists，config 内容不被改写', async () => {
    await createCommand(makeDeps(), 'gamma', { audit: makeAudit().audit });

    // 模拟 winner 之后用户自定义了 config
    fs.writeFileSync(configFile('gamma'), `name: gamma\ntool_profile: readonly\nmax_concurrent_tasks: 1\n`);

    await expect(createCommand(makeDeps(), 'gamma', { audit: makeAudit().audit }))
      .rejects.toThrow(/already exists/);

    const raw = fs.readFileSync(configFile('gamma'), 'utf8');
    expect(raw).toContain('tool_profile: readonly');
  });

  it('崩溃窗口自愈：layout/AGENTS.md 已建但 config 未发布 → create 冪等完成', async () => {
    const root = clawRoot('delta');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, CLAW_SPEC_FILE), '# partial AGENTS\n');

    await createCommand(makeDeps(), 'delta', { audit: makeAudit().audit });

    const config = yaml.load(fs.readFileSync(configFile('delta'), 'utf8')) as Record<string, unknown>;
    expect(config.name).toBe('delta');
    expect(fs.existsSync(path.join(root, CLAW_SPEC_FILE))).toBe(true);
  });

  it('config 已存在但 AGENTS.md 缺失 → fail-closed already-exists，不补写模板不覆盖', async () => {
    const root = clawRoot('epsilon');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(configFile('epsilon'), `name: epsilon\ntool_profile: full\nmax_concurrent_tasks: 3\n`);

    await expect(createCommand(makeDeps(), 'epsilon', { audit: makeAudit().audit }))
      .rejects.toThrow(/already exists/);

    // 不覆盖 config、不补写 AGENTS.md（保留现场交 recovery）
    expect(fs.existsSync(path.join(root, CLAW_SPEC_FILE))).toBe(false);
    expect(fs.readFileSync(configFile('epsilon'), 'utf8')).toContain('name: epsilon');
  });
});
