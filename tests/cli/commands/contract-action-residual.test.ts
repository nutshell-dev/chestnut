/**
 * phase 1879 Step B (cli-contract-action-residual-overassembly): 构造面消除 source-scan。
 *
 * claw-status / start 两命令的 ContractSystem+ToolRegistry 直构造 → Assembly 窄 action
 * context（1874 Step F 的 createContractActionContext / 同族 motion 变体
 * createMotionContractActionContext）；audit 句柄由 context own、动作终态 dispose。
 *
 * 形态对齐 tests/cli/steps-hint-invariant.test.ts 的 src source-scan 先例。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('phase 1879 Step B: contract action residual overassembly 收口', () => {
  const TARGETS = [
    'src/cli/commands/claw-status.ts',
    'src/cli/commands/start.ts',
  ];

  it('两命令不再直构造 ContractSystem / createToolRegistry', () => {
    for (const rel of TARGETS) {
      const src = readSrc(rel);
      expect(src, rel).not.toContain('new ContractSystem');
      expect(src, rel).not.toContain('createToolRegistry(');
    }
  });

  it('claw-status 消费 createContractActionContext 且终态 dispose', () => {
    const src = readSrc('src/cli/commands/claw-status.ts');
    expect(src).toContain('createContractActionContext');
    expect(src).toContain('action.dispose()');
    // finally 对称（dispose 在 finally 块内）
    expect(src).toMatch(/}\s*finally\s*{\s*action\.dispose\(\);?\s*}/);
  });

  it('start 两处 onboarding create 均消费 createMotionContractActionContext 且终态 dispose', () => {
    const src = readSrc('src/cli/commands/start.ts');
    expect(src).not.toContain('createContractActionContext(deps, name');
    const uses = src.match(/createMotionContractActionContext\(deps\)/g) ?? [];
    expect(uses.length).toBe(2);
    const disposes = src.match(/action\.dispose\(\)/g) ?? [];
    expect(disposes.length).toBe(2);
  });

  it('Assembly 窄入口面：contract-action.ts 提供 motion 变体且经 barrel 导出', () => {
    const actionSrc = readSrc('src/assembly/contract-action.ts');
    expect(actionSrc).toContain('export async function createMotionContractActionContext');
    const barrel = readSrc('src/assembly/index.ts');
    expect(barrel).toContain('createMotionContractActionContext');
  });
});
