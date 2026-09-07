/**
 * Phase 1796: CLI-safe guidance token 边界专测（cli-protocol-guidance-token-undervalidated）。
 *
 * - 非法 token（空 / 空白 / 控制字符 / option-like 前导 `-`）在 factory 构造期 fail-fast；
 * - 合法 token（owner codec 实际值域 `[A-Za-z0-9_-]` 的 CLI-safe 子集 + `.`/`_`）通过；
 * - renderer 边界：action token 字段类型为 CliSafeToken brand（构造期保证），
 *   renderer 不再对裸 string 重验（type-level satisfies 锁）。
 */
import { describe, it, expect } from 'vitest';
import {
  createCliSafeToken,
  renderCliGuidanceAction,
  CliGuidanceRenderError,
  type CliSafeToken,
  type CliGuidanceAction,
} from '../../../src/cli-protocol/index.js';

describe('cli guidance CliSafeToken (phase 1796)', () => {
  it('非法 token 构造期 fail-fast：空 / 空白 / 控制字符 / option-like 前导 `-`', () => {
    const illegal = ['', 'claw A', 'claw\tA', 'claw\nA', '-x', '--limit', 'a b', 'a\u0007b', '-'];
    for (const raw of illegal) {
      expect(() => createCliSafeToken(raw), `token ${JSON.stringify(raw)}`).toThrowError(CliGuidanceRenderError);
    }
  });

  it('合法 token 通过 factory：kebab / 数字起始 / `.` `_` 字符集', () => {
    for (const raw of ['worker', 'abc-123', 'c1', '9lives', 'claw_A', 'rel.2']) {
      expect(createCliSafeToken(raw)).toBe(raw);
    }
  });

  it('renderer 边界：brand token 直通渲染（不再重验、不复制 identity 规则）', () => {
    const clawId: CliSafeToken = createCliSafeToken('worker');
    const contractId: CliSafeToken = createCliSafeToken('c1');
    // satisfies 锁 action token 字段只接受 CliSafeToken（裸 string 构造不过编译）
    const action = {
      kind: 'claw.trace',
      clawId,
      contractId,
    } satisfies CliGuidanceAction;
    expect(renderCliGuidanceAction(action)).toBe('chestnut claw worker trace --contract c1');
  });
});
