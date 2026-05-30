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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  dispatchClawSubcommand,
  renderClawTopHelp,
  renderClawVerbHelp,
} from '../../../src/cli/commands/claw-router.js';
import { CliError } from '../../../src/cli/errors.js';

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
    expect(out).toContain('Usage: clawforum claw <claw-name> send <message>');
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
    expect(out).toContain('Usage: clawforum claw <claw-name> send <message>');
  });

  it('`claw <name> <verb> -h` short-circuits to per-verb help', async () => {
    await dispatchClawSubcommand('alice', ['outbox', '-h'], fakeDeps);
    const out = writes.join('');
    expect(out).toContain('Usage: clawforum claw <claw-name> outbox');
    expect(out).toContain('--limit');
  });

  it('`help` is reserved and cannot be used as claw name in `<name> <verb>` form', async () => {
    // subject === 'help' takes the help routing path first, so it never reaches
    // the RESERVED_SUBJECTS guard. This test documents the precedence: help
    // routing wins, so `claw help foo` is interpreted as help-for-verb-foo,
    // not as create-claw-named-help.
    await expect(dispatchClawSubcommand('help', ['create'], fakeDeps)).resolves.toBeUndefined();
    expect(writes.join('')).toContain('Usage: clawforum claw <claw-name> create');
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
