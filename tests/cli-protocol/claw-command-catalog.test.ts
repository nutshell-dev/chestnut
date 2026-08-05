import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchClawSubcommand } from '../../src/cli/commands/claw-router.js';
import { CliError } from '../../src/cli/errors.js';
import {
  CLAW_COMMAND_CATALOG,
  CLAW_INSTANCE_COMMAND_IDS,
  getClawCommandSpec,
  renderClawHelp,
  renderClawCommandHelp,
} from '../../src/cli-protocol/index.js';

/**
 * claw command catalog 单源 invariants — phase 1477 Step B4 立 / phase 1253 Step C
 * 迁 CLIProtocol（原 tests/cli/help/help-invariants.test.ts、行为断言保留）。
 *
 * Covers:
 * - 每 spec 含必填字段 (id / group / form / summary)
 * - id 在 catalog 内唯一
 * - CLAW_INSTANCE_COMMAND_IDS 由 catalog instance-form spec 派生（单源）
 * - flat-form 含且仅含 ['list', 'help']（β 基础设施约定）
 * - example 字面以 `chestnut claw` 起头（防漂移到旧 verb-first 形态）
 *
 * 反向 1：catalog 新增 instance command 但 router 未加 case → router switch
 *   exhaustiveness guard（`const _exhaustive: never = verb`）编译失败（phase 1253 实测）
 * 反向 2：example 字面写 `chestnut claw create alice`（旧 verb-first）→ 失败
 */

describe('CLAW_COMMAND_CATALOG invariants', () => {
  it('every spec has required fields', () => {
    for (const spec of CLAW_COMMAND_CATALOG) {
      expect(spec.id).toMatch(/^[a-z][a-z-]*$/);
      expect(spec.summary.length).toBeGreaterThan(0);
      expect(['lifecycle', 'messaging', 'observation', 'discovery']).toContain(spec.group);
      expect(['instance', 'flat']).toContain(spec.form);
    }
  });

  it('command ids are unique within the catalog', () => {
    const seen = new Set<string>();
    for (const spec of CLAW_COMMAND_CATALOG) {
      expect(seen.has(spec.id)).toBe(false);
      seen.add(spec.id);
    }
  });

  it('CLAW_INSTANCE_COMMAND_IDS derives from catalog instance-form specs (single source)', () => {
    const instanceSpecIds = CLAW_COMMAND_CATALOG.filter((s) => s.form === 'instance')
      .map((s) => s.id);
    expect(CLAW_INSTANCE_COMMAND_IDS).toEqual(instanceSpecIds);
  });

  it('flat-form commands are exactly [list, help]', () => {
    const flatIds = CLAW_COMMAND_CATALOG.filter((s) => s.form === 'flat')
      .map((s) => s.id)
      .sort();
    expect(flatIds).toEqual(['help', 'list']);
  });

  it('every example begins with `chestnut claw` (no verb-first regression)', () => {
    for (const spec of CLAW_COMMAND_CATALOG) {
      for (const ex of spec.examples ?? []) {
        expect(ex.startsWith('chestnut claw ')).toBe(true);
      }
    }
  });

});

/**
 * CLIProtocol help renderer 渲染契约 — phase 1477 Step B4 立 / phase 1253 Step C 迁。
 *
 * Covers:
 * - 顶层 help 含 4 个 group header + Usage 三行 + Examples 段 + Notes 段（含 cp 退役提示）
 * - 顶层 help 含每 command 的 summary 字面（防 renderer 漏渲染）
 * - 顶层 help 不出现 commander 内部抽象 `<subject>` 字面（替代 commander 默认 Usage 的契约）
 * - 顶层 help 不包含旧 verb-first 形态字面 `claw create <name>` 等（防回归）
 * - per-verb help (instance form) 含 `chestnut claw <claw-name> <verb>` Usage 行
 * - per-verb help (flat form) 含 `chestnut claw <verb>` Usage 行（无 <claw-name>）
 * - per-verb help 含 args / options / examples 段（当 fact 提供时）
 *
 * 反向 1：renderer 输出含 `chestnut` binary 字面（确认 CLIProtocol 物理拼装、phase 1253）
 * 反向 2：顶层 help 含 `claw help [<verb>]` 入口字面（α 路由文档化）
 */

describe('renderClawHelp (top-level)', () => {
  const help = renderClawHelp();

  it('contains all four group headers', () => {
    expect(help).toContain('Lifecycle:');
    expect(help).toContain('Messaging:');
    expect(help).toContain('Observation:');
    expect(help).toContain('Discovery:');
  });

  it('contains Usage block with three forms', () => {
    expect(help).toContain('chestnut claw <claw-name> <verb> [args]');
    expect(help).toContain('chestnut claw list [--json]');
    expect(help).toContain('chestnut claw help [<verb>]');
  });

  it('contains every verb summary string', () => {
    for (const spec of CLAW_COMMAND_CATALOG) {
      if (spec.id === 'help') continue; // help is described by the Usage block itself
      expect(help).toContain(spec.summary);
    }
  });

  it('does not include verbose Examples / Notes sections in top-level help', () => {
    // phase 1479 ratify：Examples / Notes 段在顶层无用、user explicit 删
    expect(help).not.toContain('Examples:');
    expect(help).not.toContain('Notes:');
  });

  it('top-level signature surfaces required options (phase 1480 silent-X fix)', () => {
    // trace verb's required option `--contract <contractId>` must appear on
    // the top-level help row, not be hidden until the user runs the command
    // and gets `required option '--contract <contractId>' not specified`.
    expect(help).toMatch(/^\s+trace\s+--contract <contractId>\s+/m);
  });

  it('does not leak commander internal `<subject>` placeholder', () => {
    expect(help).not.toContain('<subject>');
  });

  it('does not regress to verb-first form like `claw create <name>`', () => {
    expect(help).not.toMatch(/claw create <name>/);
    expect(help).not.toMatch(/claw send <name>/);
  });

  it('includes the `chestnut` binary literal (CLIProtocol owns help rendering, phase 1253)', () => {
    expect(help).toContain('chestnut');
  });
});

describe('renderClawCommandHelp (per-command)', () => {
  it('instance form: Usage row carries `<claw-name>` placeholder', () => {
    const out = renderClawCommandHelp('send')!;
    expect(out).toContain('Usage: chestnut claw <claw-name> send <message>');
  });

  it('flat form: Usage row omits `<claw-name>`', () => {
    const out = renderClawCommandHelp('list')!;
    expect(out).toContain('Usage: chestnut claw list');
    expect(out).not.toContain('<claw-name>');
  });

  it('renders Arguments section when spec has args', () => {
    const out = renderClawCommandHelp('send')!;
    expect(out).toContain('Arguments:');
    expect(out).toContain('Message body');
  });

  it('renders Options section when spec has options', () => {
    const out = renderClawCommandHelp('outbox')!;
    expect(out).toContain('Options:');
    expect(out).toContain('--limit <n>');
  });

  it('renders Examples section when spec has examples', () => {
    const out = renderClawCommandHelp('create')!;
    expect(out).toContain('Examples:');
    expect(out).toContain('chestnut claw alice create');
  });

  it('handles spec with neither args nor options', () => {
    const out = renderClawCommandHelp('stop')!;
    expect(out).toContain('Usage:');
    expect(out).toContain(getClawCommandSpec('stop')!.summary);
    expect(out).not.toContain('Arguments:');
    expect(out).not.toContain('Options:');
  });
});

describe('getClawCommandSpec', () => {
  it('returns the fact for a registered verb', () => {
    const spec = getClawCommandSpec('send');
    expect(spec?.id).toBe('send');
  });

  it('returns undefined for unknown verb', () => {
    expect(getClawCommandSpec('nonexistent')).toBeUndefined();
  });
});

/**
 * Router help routing — phase 1477 Step B4.
 *
 * Covers:
 * - `claw --help` / `claw -h` → top-level help written to stdout
 * - `claw help` → top-level help
 * - `claw help <verb>` → per-verb help
 * - `claw help <unknown-verb>` → CliError
 * - `claw <name> <verb> --help` → per-verb help short-circuit (before option parser)
 * - `help` reserved as subject (cannot be claw name in `claw <name> <verb>` form)
 *
 * 反向 1：renderClawCommandHelp 与 catalog query 共源 → 改 spec id 后两个都会失败
 */


const fakeDeps = {
  fsFactory: (() => ({})) as never,
  // phase 1301 Step B：RouterDeps 新增 required 窄 RootConfig；help 路径不触发 guard，
  // stub 仅满足类型，不应被调用。
  rootConfig: {
    loadGlobal: () => {
      throw new Error('loadGlobal must not be called from help routing');
    },
    loadClaw: () => {
      throw new Error('loadClaw must not be called from help routing');
    },
  },
};

describe('claw help routing', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let writes: string[];

  beforeEach(() => {
    writes = [];
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('bare `claw` (no subject) writes top-level help', async () => {
    await dispatchClawSubcommand(undefined, [], fakeDeps);
    expect(writes.join('')).toContain('Lifecycle:');
    expect(writes.join('')).toContain('Usage:');
  });

  it('`claw --help` writes top-level help', async () => {
    await dispatchClawSubcommand('--help', [], fakeDeps);
    expect(writes.join('')).toContain('Lifecycle:');
  });

  it('`claw -h` writes top-level help', async () => {
    await dispatchClawSubcommand('-h', [], fakeDeps);
    expect(writes.join('')).toContain('Usage:');
  });

  it('`claw help` writes top-level help', async () => {
    await dispatchClawSubcommand('help', [], fakeDeps);
    expect(writes.join('')).toContain('Messaging:');
  });

  it('`claw help send` writes per-verb help', async () => {
    await dispatchClawSubcommand('help', ['send'], fakeDeps);
    const out = writes.join('');
    expect(out).toContain('Usage: chestnut claw <claw-name> send <message>');
    expect(out).toContain('Examples:');
  });

  it('`claw help <unknown>` raises CliError', async () => {
    await expect(dispatchClawSubcommand('help', ['nonexistent'], fakeDeps)).rejects.toBeInstanceOf(
      CliError,
    );
  });

  it('`claw <name> <verb> --help` short-circuits to per-verb help', async () => {
    await dispatchClawSubcommand('alice', ['send', '--help'], fakeDeps);
    const out = writes.join('');
    expect(out).toContain('Usage: chestnut claw <claw-name> send <message>');
  });

  it('`claw <name> <verb> -h` short-circuits to per-verb help', async () => {
    await dispatchClawSubcommand('alice', ['outbox', '-h'], fakeDeps);
    const out = writes.join('');
    expect(out).toContain('Usage: chestnut claw <claw-name> outbox');
    expect(out).toContain('--limit');
  });

  it('`help` is reserved and cannot be used as claw name in `<name> <verb>` form', async () => {
    // subject === 'help' takes the help routing path first, so it never reaches
    // the RESERVED_SUBJECTS guard. This test documents the precedence: help
    // routing wins, so `claw help foo` is interpreted as help-for-verb-foo,
    // not as create-claw-named-help.
    await expect(dispatchClawSubcommand('help', ['create'], fakeDeps)).resolves.toBeUndefined();
    expect(writes.join('')).toContain('Usage: chestnut claw <claw-name> create');
  });
});

describe('renderers are pure (no side effects)', () => {
  it('renderClawHelp returns a non-empty string', () => {
    const out = renderClawHelp();
    expect(out.length).toBeGreaterThan(50);
    expect(out).toContain('Lifecycle:');
  });

  it('renderClawCommandHelp returns string for known command', () => {
    expect(renderClawCommandHelp('send')).toContain('Usage:');
  });

  it('renderClawCommandHelp returns undefined for unknown command', () => {
    expect(renderClawCommandHelp('nonexistent')).toBeUndefined();
  });
});

