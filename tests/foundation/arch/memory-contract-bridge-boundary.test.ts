/**
 * Phase 1807 Step B (MEMORY-CONTRACT-BRIDGE-OVERWIDE-ADAPTER): Memory ↔ Contract
 * 边界专测。
 *
 * 锁定：`src/core/memory/claw-contract-bridge.ts` 只注入窄 `ContractProgressReader`
 * capability——禁止 import 完整 ContractSystem 装配（createContractSystem）、
 * LLM、ToolRegistry、notifyClaw、audit 构造与 FileSystem；反向锚定装配层
 * （motion-addons.ts）必须持有 createReader 适配与 close 责任。
 *
 * phase 1808 Step B 演化：装配层 close 改经 `closeBridgeContractSystems`
 * typed outcome helper（逐条 clawId/error 证据），close 责任仍在装配层——
 * 本文件锚定新 helper 调用点，不断言已移除的 allSettled 字面模式。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const bridgePath = path.join(process.cwd(), 'src/core/memory', 'claw-contract-bridge.ts');
const assemblyPath = path.join(process.cwd(), 'src/assembly', 'motion-addons.ts');

/** Memory 侧禁止出现的宽依赖符号/模块。 */
const FORBIDDEN_IN_BRIDGE = [
  'createContractSystem',
  'ContractSystem',
  'LLMOrchestrator',
  'llm-orchestrator',
  'ToolRegistry',
  'foundation/tools',
  'NotifyClawFn',
  'notifyClaw',
  'createSystemAudit',
  'FileSystem',
  'foundation/fs',
] as const;

describe('phase 1807: Memory ↔ Contract bridge 窄 capability 边界', () => {
  // 扫描前剥离注释：禁列符号允许出现在文档叙述中，只锁定真实 import/代码依赖。
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const bridge = stripComments(fs.readFileSync(bridgePath, 'utf8'));
  const assembly = fs.readFileSync(assemblyPath, 'utf8');

  it('bridge 只依赖窄 ContractProgressReader + topology/identity 类型', () => {
    for (const symbol of FORBIDDEN_IN_BRIDGE) {
      expect(bridge).not.toMatch(new RegExp(`\\b${symbol}\\b`));
    }
    // 正向锚定：窄 capability 契约存在
    expect(bridge).toContain('ContractProgressReader');
    expect(bridge).toContain('createReader');
  });

  it('bridge dispose 不再触碰 close（reader 生命周期归装配层）', () => {
    expect(bridge).not.toMatch(/\.close\(\)/);
  });

  it('装配层持有 createReader 适配 + 底层 manager close 责任（phase 1808：close 经 typed outcome helper）', () => {
    expect(assembly).toContain('createReader');
    expect(assembly).toContain('createContractSystem');
    expect(assembly).toContain('closeBridgeContractSystems(bridgeContractSystems)');
  });
});
