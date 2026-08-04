import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * phase 503: invariant test for foundation/uuid + foundation/hash owner module APIs.
 *
 * Asserts canonical exports exist. Renaming a function or removing
 * one breaks downstream callers and dual lint protection — this catches
 * the regression at test time.
 *
 * phase 574 扩 (phase 520-554 follow-up): 加 3 it block 覆盖新 owner module API:
 *   - core/claw-topology: MOTION_CLAW_ID + makeAgentDirResolver
 *   - cli-protocol: CLAW_COMMAND_CATALOG + getClawCommandSpec + typed guidance API (phase 1253)
 *     phase 1270 Step A: 旧 invocation 符号（renderClawInvocation / CONTRACT_COMMANDS /
 *     ContractCommand）从 barrel 退役 — 反向断言 namespace 不可见 + 源码无 ContractCommand 残留
 *     phase 1278 Step A: formatClawStatusHint 归位 CLIProtocol public barrel —
 *     正向断言 barrel 暴露 + exact 核心片段；旧 cli/utils owner 反向断言符号不存在、
 *     formatNoActiveContractHint 仍留
 */
describe('owner modules API presence (phase 503 / phase 574 expanded)', () => {
  it('foundation/node-utils/id exposes newUuid, newShortUuid, randomHex', async () => {
    const uuidMod = await import('../../../src/foundation/node-utils/id.js');
    expect(typeof uuidMod.newUuid).toBe('function');
    expect(typeof uuidMod.newShortUuid).toBe('function');
    expect(typeof uuidMod.randomHex).toBe('function');

    const id = uuidMod.newUuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(uuidMod.newShortUuid().length).toBe(8);
    expect(uuidMod.newShortUuid(12).length).toBe(12);
    expect(uuidMod.randomHex(8).length).toBe(16);
  });

  it('foundation/node-utils/crypto exposes sha256Hex, sha256ShortHex, createSha256Hasher', async () => {
    const hashMod = await import('../../../src/foundation/node-utils/crypto.js');
    expect(typeof hashMod.sha256Hex).toBe('function');
    expect(typeof hashMod.sha256ShortHex).toBe('function');
    expect(typeof hashMod.createSha256Hasher).toBe('function');

    expect(hashMod.sha256Hex('test')).toBe(
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    );
    expect(hashMod.sha256ShortHex('test', 8)).toBe('9f86d081');

    const h = hashMod.createSha256Hasher();
    h.update('test');
    expect(h.digest()).toBe(
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    );
  });

  // phase 574 扩: phase 520-554 引入新 owner module API invariant

  it('core/claw-topology exposes MOTION_CLAW_ID + makeAgentDirResolver (phase 520/535)', async () => {
    const topoMod = await import('../../../src/core/claw-topology/index.js');
    expect(typeof topoMod.MOTION_CLAW_ID).toBe('string');
    expect(topoMod.MOTION_CLAW_ID).toBe('motion');
    expect(typeof topoMod.makeAgentDirResolver).toBe('function');
    const resolver = topoMod.makeAgentDirResolver();
    expect(typeof resolver).toBe('function');
    // motion goes to subroot, others to claws/<id>
    expect(typeof resolver('motion')).toBe('string');
    expect(typeof resolver('other-claw')).toBe('string');
  });

  it('cli-protocol barrel exposes formatClawStatusHint（phase 1278 Step A: owner 归位）', async () => {
    const protocol = await import('../../../src/cli-protocol/index.js');
    expect(typeof protocol.formatClawStatusHint).toBe('function');
    expect(protocol.formatClawStatusHint('x', true)).toBeUndefined();
    expect(protocol.formatClawStatusHint('x', false)).toBe(
      'Note: claw "x" is not running. Start it with: chestnut claw x daemon',
    );
  });

  it('cli/utils/claw-status-hints 只留 formatNoActiveContractHint（phase 1278 Step A 反向断言）', async () => {
    const hintsMod = await import('../../../src/cli/utils/claw-status-hints.js');
    expect('formatClawStatusHint' in hintsMod).toBe(false);
    expect(typeof hintsMod.formatNoActiveContractHint).toBe('function');
    expect(hintsMod.formatNoActiveContractHint('x', true)).toBeUndefined();
    expect(hintsMod.formatNoActiveContractHint('x', false)).toMatch(/No active contract for "x"/);
  });

  it('cli-protocol barrel 公开 catalog/query/typed guidance API（phase 1253 / 1263—1267）', async () => {
    const protocol = await import('../../../src/cli-protocol/index.js');
    expect(Array.isArray(protocol.CLAW_COMMAND_CATALOG)).toBe(true);
    expect(protocol.CLAW_COMMAND_CATALOG.length).toBeGreaterThan(0);
    expect(typeof protocol.getClawCommandSpec).toBe('function');
    expect(protocol.getClawCommandSpec('chat')?.id).toBe('chat');
    expect(protocol.getClawCommandSpec('nonexistent')).toBeUndefined();
    // typed guidance 核心 API（phase 1263—1267 后的 CLI affordance 公共入口）
    expect(typeof protocol.renderCliGuidanceAction).toBe('function');
    expect(typeof protocol.renderCliGuidanceDocument).toBe('function');
    expect(typeof protocol.registerCliGuidance).toBe('function');
    expect(typeof protocol.defineCliGuidanceBinding).toBe('function');
    expect(typeof protocol.CliGuidanceRenderError).toBe('function');
  });

  it('cli-protocol barrel 公开 viewport 配置协议（phase 1283 Step A: viewportConfigSchema + inline 默认值）', async () => {
    const protocol = await import('../../../src/cli-protocol/index.js');
    expect(typeof protocol.viewportConfigSchema).toBe('object');
    expect(protocol.viewportConfigSchema.parse({}).user_input_inline_max_chars).toBe(2000);
    expect(protocol.VIEWPORT_USER_INPUT_INLINE_MAX_CHARS_DEFAULT).toBe(2000);
  });

  it('cli-protocol barrel 不再公开旧 invocation 符号（phase 1270 Step A 反向断言）', async () => {
    const protocol = await import('../../../src/cli-protocol/index.js');
    expect('renderClawInvocation' in protocol).toBe(false);
    expect('CONTRACT_COMMANDS' in protocol).toBe(false);
    // ContractCommand 是 type export、dynamic import 不可见，必须做源码 negative assertion
    const cliProtocolDir = path.resolve(__dirname, '../../../src/cli-protocol');
    for (const file of ['index.ts', 'invocation.ts']) {
      const text = fs.readFileSync(path.join(cliProtocolDir, file), 'utf8');
      expect(text.includes('ContractCommand'), `${file} must not reference ContractCommand`).toBe(false);
    }
  });
});
