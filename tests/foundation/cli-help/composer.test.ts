/**
 * Assembly composer 渲染契约 — phase 1477 Step B4.
 *
 * Covers:
 * - 顶层 help 含 4 个 group header + Usage 三行 + Examples 段 + Notes 段（含 cp 退役提示）
 * - 顶层 help 含每 verb 的 summary 字面（防 composer 漏渲染）
 * - 顶层 help 不出现 commander 内部抽象 `<subject>` 字面（替代 commander 默认 Usage 的契约）
 * - 顶层 help 不包含旧 verb-first 形态字面 `claw create <name>` 等（防回归）
 * - per-verb help (instance form) 含 `clawforum claw <claw-name> <verb>` Usage 行
 * - per-verb help (flat form) 含 `clawforum claw <verb>` Usage 行（无 <claw-name>）
 * - per-verb help 含 args / options / examples 段（当 fact 提供时）
 *
 * 反向 1：composer 输出含 `clawforum` binary 字面（确认 Assembly 物理拼装）
 * 反向 2：顶层 help 含 `claw help [<verb>]` 入口字面（α 路由文档化）
 */

import { describe, it, expect } from 'vitest';
import {
  composeClawHelp,
  composeClawVerbHelp,
  findVerbFact,
} from '../../../src/assembly/cli-help/index.js';
import {
  CLAW_VERB_FACTS,
  CLAW_RETIRED_VERBS,
} from '../../../src/foundation/cli-help/index.js';

describe('composeClawHelp (top-level)', () => {
  const help = composeClawHelp(CLAW_VERB_FACTS, CLAW_RETIRED_VERBS);

  it('contains all four group headers', () => {
    expect(help).toContain('Lifecycle:');
    expect(help).toContain('Messaging:');
    expect(help).toContain('Observation:');
    expect(help).toContain('Discovery:');
  });

  it('contains Usage block with three forms', () => {
    expect(help).toContain('clawforum claw <claw-name> <verb> [args]');
    expect(help).toContain('clawforum claw list [--json]');
    expect(help).toContain('clawforum claw help [<verb>]');
  });

  it('contains every verb summary string', () => {
    for (const fact of CLAW_VERB_FACTS) {
      if (fact.name === 'help') continue; // help is described by the Usage block itself
      expect(help).toContain(fact.summary);
    }
  });

  it('contains an Examples section', () => {
    expect(help).toContain('Examples:');
  });

  it('contains a Notes section with cp deprecation', () => {
    expect(help).toContain('Notes:');
    expect(help).toContain('`cp`');
    expect(help).toContain('`import`');
  });

  it('does not leak commander internal `<subject>` placeholder', () => {
    expect(help).not.toContain('<subject>');
  });

  it('does not regress to verb-first form like `claw create <name>`', () => {
    expect(help).not.toMatch(/claw create <name>/);
    expect(help).not.toMatch(/claw send <name>/);
  });

  it('includes the `clawforum` binary literal (composer is the assembly point)', () => {
    expect(help).toContain('clawforum');
  });
});

describe('composeClawVerbHelp (per-verb)', () => {
  it('instance form: Usage row carries `<claw-name>` placeholder', () => {
    const fact = findVerbFact(CLAW_VERB_FACTS, 'send')!;
    const out = composeClawVerbHelp(fact);
    expect(out).toContain('Usage: clawforum claw <claw-name> send <message>');
  });

  it('flat form: Usage row omits `<claw-name>`', () => {
    const fact = findVerbFact(CLAW_VERB_FACTS, 'list')!;
    const out = composeClawVerbHelp(fact);
    expect(out).toContain('Usage: clawforum claw list');
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
    expect(out).toContain('clawforum claw alice create');
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
