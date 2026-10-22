/**
 * Phase 1972: provider UX 的 secret 保护与非 TTY 行为。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { passwordQuestion } from '../../src/cli/utils/password-prompt.js';
import { CliError } from '../../src/cli/errors.js';
import { setupDraftPreviewLines } from '../../src/templates/messages/index.js';

const originalIsTTY = process.stdin.isTTY;

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
});

describe('passwordQuestion — 非 TTY', () => {
  it('非 TTY 直接拒绝，不退回明文回显', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    expect(() => passwordQuestion({ question: vi.fn() } as never, 'API Key: '))
      .toThrow(CliError);
    expect(() => passwordQuestion({ question: vi.fn() } as never, 'API Key: '))
      .toThrow(/requires a TTY/);
  });
});

describe('setupDraftPreviewLines — 脱敏', () => {
  it('只显示 credential reference，不包含明文 key', () => {
    const lines = setupDraftPreviewLines({
      label: 'Anthropic',
      model: 'claude-3',
      auth: 'API key',
      keyRef: '${ANTHROPIC_API_KEY}',
      role: 'primary',
    });
    const text = lines.join('\n');
    expect(text).toContain('${ANTHROPIC_API_KEY}');
    expect(text).not.toContain('sk-live-secret');
  });
});
