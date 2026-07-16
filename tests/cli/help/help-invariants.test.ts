import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  composeClawHelp,
  composeClawVerbHelp,
  findVerbFact,
} from '../../../src/assembly/cli-help/index.js';
import {
  __TEST_VERB_NAMES_FROM_ROUTER,
  dispatchClawSubcommand,
  renderClawTopHelp,
  renderClawVerbHelp,
} from '../../../src/cli/commands/claw-router.js';
import { CliError } from '../../../src/cli/errors.js';
import {
  CLAW_VERB_FACTS,
  CLAW_VERB_NAMES,
} from '../../../src/cli/help/index.js';

/**
 * verb-fact 单源 invariants — phase 1477 Step B4.
 *
 * Covers:
 * - 每 fact 含必填字段 (name / group / form / summary)
 * - name 在 fact 表内唯一
 * - instance-form fact 名集合 = router VERB_NAMES（防双源 silent-X drift）
 * - flat-form 含且仅含 ['list', 'help']（β 基础设施约定）
 * - example 字面以 `chestnut claw` 起头（防漂移到旧 verb-first 形态）
 *
 * 反向 1：故意改一个 fact name → router VERB_NAMES 同步检查应失败
 * 反向 2：fact 表新增 instance verb 但 router 未加 → 失败
 * 反向 3：example 字面写 `chestnut claw create alice`（旧 verb-first）→ 失败
 */

// Router's authoritative verb list. Imported via the router module to assert
// the two are kept in lockstep at type/runtime layer.

describe('CLAW_VERB_FACTS invariants', () => {
  it('every fact has required fields', () => {
    for (const fact of CLAW_VERB_FACTS) {
      expect(fact.name).toMatch(/^[a-z][a-z-]*$/);
      expect(fact.summary.length).toBeGreaterThan(0);
      expect(['lifecycle', 'messaging', 'observation', 'discovery']).toContain(fact.group);
      expect(['instance', 'flat']).toContain(fact.form);
    }
  });

  it('verb names are unique within the fact table', () => {
    const seen = new Set<string>();
    for (const fact of CLAW_VERB_FACTS) {
      expect(seen.has(fact.name)).toBe(false);
      seen.add(fact.name);
    }
  });

  it('instance-form fact name set matches router VERB_NAMES (no double-source drift)', () => {
    const instanceFactNames = CLAW_VERB_FACTS.filter((f) => f.form === 'instance')
      .map((f) => f.name)
      .sort();
    const routerNames = [...__TEST_VERB_NAMES_FROM_ROUTER].sort();
    expect(instanceFactNames).toEqual(routerNames);
  });

  it('flat-form verbs are exactly [list, help]', () => {
    const flatNames = CLAW_VERB_FACTS.filter((f) => f.form === 'flat')
      .map((f) => f.name)
      .sort();
    expect(flatNames).toEqual(['help', 'list']);
  });

  it('every example begins with `chestnut claw` (no verb-first regression)', () => {
    for (const fact of CLAW_VERB_FACTS) {
      for (const ex of fact.examples ?? []) {
        expect(ex.startsWith('chestnut claw ')).toBe(true);
      }
    }
  });

  it('CLAW_VERB_NAMES mirrors CLAW_VERB_FACTS order/length', () => {
    expect(CLAW_VERB_NAMES).toEqual(CLAW_VERB_FACTS.map((f) => f.name));
  });

});

/**
 * Assembly composer 渲染契约 — phase 1477 Step B4.
 *
 * Covers:
 * - 顶层 help 含 4 个 group header + Usage 三行 + Examples 段 + Notes 段（含 cp 退役提示）
 * - 顶层 help 含每 verb 的 summary 字面（防 composer 漏渲染）
 * - 顶层 help 不出现 commander 内部抽象 `<subject>` 字面（替代 commander 默认 Usage 的契约）
 * - 顶层 help 不包含旧 verb-first 形态字面 `claw create <name>` 等（防回归）
 * - per-verb help (instance form) 含 `chestnut claw <claw-name> <verb>` Usage 行
 * - per-verb help (flat form) 含 `chestnut claw <verb>` Usage 行（无 <claw-name>）
 * - per-verb help 含 args / options / examples 段（当 fact 提供时）
 *
 * 反向 1：composer 输出含 `chestnut` binary 字面（确认 Assembly 物理拼装）
 * 反向 2：顶层 help 含 `claw help [<verb>]` 入口字面（α 路由文档化）
 */

describe('composeClawHelp (top-level)', () => {
  const help = composeClawHelp(CLAW_VERB_FACTS);

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
    for (const fact of CLAW_VERB_FACTS) {
      if (fact.name === 'help') continue; // help is described by the Usage block itself
      expect(help).toContain(fact.summary);
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

  it('includes the `chestnut` binary literal (composer is the assembly point)', () => {
    expect(help).toContain('chestnut');
  });
});

describe('composeClawVerbHelp (per-verb)', () => {
  it('instance form: Usage row carries `<claw-name>` placeholder', () => {
    const fact = findVerbFact(CLAW_VERB_FACTS, 'send')!;
    const out = composeClawVerbHelp(fact);
    expect(out).toContain('Usage: chestnut claw <claw-name> send <message>');
  });

  it('flat form: Usage row omits `<claw-name>`', () => {
    const fact = findVerbFact(CLAW_VERB_FACTS, 'list')!;
    const out = composeClawVerbHelp(fact);
    expect(out).toContain('Usage: chestnut claw list');
    expect(out).not.toContain('<claw-name>');
  });

  it('renders Arguments section when fact has args', () => {
    const fact = findVerbFact(CLAW_VERB_FACTS, 'send')!;
    const out = composeClawVerbHelp(fact);
    expect(out).toContain('Arguments:');
    expect(out).toContain('Message body');
  });

  it('renders Options section when fact has options', () => {
    const fact = findVerbFact(CLAW_VERB_FACTS, 'outbox')!;
    const out = composeClawVerbHelp(fact);
    expect(out).toContain('Options:');
    expect(out).toContain('--limit <n>');
  });

  it('renders Examples section when fact has examples', () => {
    const fact = findVerbFact(CLAW_VERB_FACTS, 'create')!;
    const out = composeClawVerbHelp(fact);
    expect(out).toContain('Examples:');
    expect(out).toContain('chestnut claw alice create');
  });

  it('handles fact with neither args nor options', () => {
    const fact = findVerbFact(CLAW_VERB_FACTS, 'stop')!;
    const out = composeClawVerbHelp(fact);
    expect(out).toContain('Usage:');
    expect(out).toContain(fact.summary);
    expect(out).not.toContain('Arguments:');
    expect(out).not.toContain('Options:');
  });
});

describe('findVerbFact', () => {
  it('returns the fact for a registered verb', () => {
    const fact = findVerbFact(CLAW_VERB_FACTS, 'send');
    expect(fact?.name).toBe('send');
  });

  it('returns undefined for unknown verb', () => {
    expect(findVerbFact(CLAW_VERB_FACTS, 'nonexistent')).toBeUndefined();
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
 * 反向 1：renderClawVerbHelp 与 composer findVerbFact 共源 → 改 fact 名后两个都会失败
 */


const fakeDeps = {
  fsFactory: (() => ({})) as never,
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
  it('renderClawTopHelp returns a non-empty string', () => {
    const out = renderClawTopHelp();
    expect(out.length).toBeGreaterThan(50);
    expect(out).toContain('Lifecycle:');
  });

  it('renderClawVerbHelp returns string for known verb', () => {
    expect(renderClawVerbHelp('send')).toContain('Usage:');
  });

  it('renderClawVerbHelp returns undefined for unknown verb', () => {
    expect(renderClawVerbHelp('nonexistent')).toBeUndefined();
  });
});

