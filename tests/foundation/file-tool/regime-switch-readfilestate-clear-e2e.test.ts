/**
 * phase 1452 (F-NEXT.4 治理) + Phase 1229 Step A + phase 1850 Step D:
 * regime switch post-commit readFileState clear 端到端验证（Runtime 路径语义）。
 *
 * phase 1850 Step D 控制流变更:
 *   - PerformRegimeSwitchOpts.onSwitchComplete 注入路径移除；
 *   - Runtime._checkRegimeSwitch 在 `lastIdentityHash = identityContent`（提交判定）
 *     之后显式 `await clearReadFileState(this.execContext)`；
 *   - switch 失败路径不执行 cleanup（lastIdentityHash 不更新、下 turn 重试自愈 D7）。
 *
 * Phase 1229 Step A: clear no longer drains a background Promise-chain. Tool mutations only
 * update the in-memory Map; Runtime calls persist once per complete step. Therefore
 * clearReadFileState can directly delete the disk file.
 *
 * 本 phase 验证:
 *   1. regime switch 提交后 Runtime 执行 cleanup：真清 in-memory Map + 删 disk file
 *   2. 跨 regime switch 的 gate 决策连续性：清后下次 overwrite 必拒（reason=not-read）
 *   3. switch 失败（archive throw）时不执行 cleanup：in-memory + disk 不动
 *
 * 实施模式：真 TestRuntime（initialize + processTurn 全链路）+ mock LLM +
 * mock buildSystemPromptForRegime identity 序列触发 switch。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';

import { readTool } from '../../../src/foundation/file-tool/index.js';
import { writeTool } from '../../../src/foundation/file-tool/write.js';
import {
  persistReadFileState,
  READ_STATE_FILE,
} from '../../../src/foundation/file-tool/file-state-persist.js';
import { FILE_TOOL_AUDIT_EVENTS } from '../../../src/foundation/file-tool/audit-events.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';
import type { LLMOrchestratorConfig, LLMStreamChunk } from '../../../src/foundation/llm-orchestrator/types.js';
import type { LLMResponse } from '../../../src/foundation/llm-provider/types.js';

import { TestRuntime } from '../../helpers/test-runtime.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import { processRuntimeMessage } from '../../helpers/process-runtime-message.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';
import { TEST_LLM_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

async function* responseToStreamChunks(response: LLMResponse): AsyncIterableIterator<LLMStreamChunk> {
  for (const block of response.content) {
    if (block.type === 'text') {
      yield { type: 'text_delta', delta: (block as { text: string }).text };
    }
  }
  yield { type: 'done' };
}

function createMockLLMConfig(): LLMOrchestratorConfig {
  return {
    primary: {
      name: 'mock',
      apiKey: 'test-key',
      model: 'test-model',
      maxTokens: 1024,
      temperature: 0.7,
      timeoutMs: TEST_LLM_TIMEOUT_MS,
      apiFormat: 'anthropic' as const,
    },
    maxAttempts: 1,
    retryDelayMs: 100,
  };
}

function createMockLLM(responses: LLMResponse[]) {
  let index = 0;
  const callMock = vi.fn(async () => {
    const response = responses[index++] || responses[responses.length - 1];
    return response;
  });
  return {
    call: callMock,
    stream: vi.fn((...args: unknown[]) => {
      const result = callMock(...args);
      if (result instanceof Promise) {
        return (async function* () {
          const response = await result;
          yield* responseToStreamChunks(response as LLMResponse);
        })();
      }
      return responseToStreamChunks(result as LLMResponse);
    }),
    close: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
  };
}

function textResponse(text: string): LLMResponse {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

describe('regime switch post-commit readFileState clear e2e (phase 1850 Step D / Runtime path)', () => {
  let tempDir: string;
  let clawDir: string;
  const runtimesToStop: TestRuntime[] = [];

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
  });

  afterEach(async () => {
    for (const r of runtimesToStop.splice(0)) {
      await r.stop().catch(() => { /* silent: shutdown */ });
    }
    await cleanupTempDir(tempDir);
  });

  async function makeRuntimeWithState(
    fileName: string,
    fileContent: string,
    opts?: { archiveFails?: boolean },
  ) {
    const audit = makeAudit();
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw', auditOverride: audit.audit });
    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    await runtime.initialize();
    // isolate switch path from real archive disk move（case 3 覆盖 archive 失败路径）
    const archiveSpy = vi.spyOn(deps.sessionManager, 'archive');
    if (opts?.archiveFails) {
      archiveSpy.mockRejectedValue(new Error('archive disk full'));
    } else {
      archiveSpy.mockResolvedValue(undefined);
    }
    runtime.testSetLLM(createMockLLM([textResponse('First'), textResponse('Second')]));

    // populate ctx state via real read + persist
    const workspaceFile = path.join(clawDir, 'clawspace', fileName);
    await fs.mkdir(path.dirname(workspaceFile), { recursive: true });
    await fs.writeFile(workspaceFile, fileContent);
    const ctx = runtime.testGetExecContext();
    await readTool.execute({ path: fileName }, ctx);
    await persistReadFileState(ctx);

    return { runtime, deps, audit, ctx };
  }

  function mockIdentitySequence(runtime: TestRuntime): void {
    vi.spyOn(runtime.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'system-prompt-A', identityContent: 'identity-A' })
      .mockResolvedValueOnce({ full: 'system-prompt-B', identityContent: 'identity-B' });
  }

  async function diskStateExists(): Promise<boolean> {
    return fs.access(path.join(clawDir, READ_STATE_FILE)).then(() => true).catch(() => false);
  }

  it('case 1: switch 提交后 Runtime 执行 cleanup — 清 in-memory Map + 删 disk file', async () => {
    const { runtime, audit, ctx } = await makeRuntimeWithState('note.md', 'before switch');

    expect(ctx.readFileState.size).toBe(1);
    expect(await diskStateExists()).toBe(true);

    mockIdentitySequence(runtime);
    await processRuntimeMessage(runtime, { role: 'user', content: 'Message 1' });
    await processRuntimeMessage(runtime, { role: 'user', content: 'Message 2' });

    // 提交判定已落 + post-commit cleanup 已执行
    expect(runtime.testGetLastIdentityHash()).toBe('identity-B');
    expect(audit.events.some(e => e[0] === RUNTIME_AUDIT_EVENTS.REGIME_SWITCH_COMMITTED)).toBe(true);
    expect(ctx.readFileState.size).toBe(0);
    expect(await diskStateExists()).toBe(false);
  });

  it('case 2: after regime switch, next overwrite is rejected (gate state purged, reason=not-read)', async () => {
    const { runtime, audit, ctx } = await makeRuntimeWithState('doc.md', 'doc v1');

    // pre-switch: gate would accept overwrite
    expect(ctx.readFileState.get('clawspace/doc.md')?.isFullRead).toBe(true);

    mockIdentitySequence(runtime);
    await processRuntimeMessage(runtime, { role: 'user', content: 'Message 1' });
    await processRuntimeMessage(runtime, { role: 'user', content: 'Message 2' });

    // post-switch: gate must reject overwrite (state purged)
    const writeRes = await writeTool.execute({ path: 'doc.md', content: 'post-switch attack' }, ctx);
    expect(writeRes.success).toBe(false);
    expect(writeRes.content).toMatch(/not been fully read/);

    const gateAudits = audit.events.filter(e => e[0] === FILE_TOOL_AUDIT_EVENTS.OVERWRITE_GATE_REJECTED);
    expect(gateAudits.length).toBe(1);
    expect(gateAudits[0].join(' ')).toMatch(/reason=not-read/);

    // 文件磁盘内容未变（写被拒）
    const onDisk = await fs.readFile(path.join(clawDir, 'clawspace/doc.md'), 'utf-8');
    expect(onDisk).toBe('doc v1');
  });

  it('case 3: switch 失败（archive throw）时不执行 cleanup — in-memory + disk 不动、hash 不更新', async () => {
    const { runtime, audit, ctx } = await makeRuntimeWithState('keep.md', 'before fail', { archiveFails: true });

    expect(ctx.readFileState.size).toBe(1);
    expect(await diskStateExists()).toBe(true);

    mockIdentitySequence(runtime);
    await processRuntimeMessage(runtime, { role: 'user', content: 'Message 1' });
    await processRuntimeMessage(runtime, { role: 'user', content: 'Message 2' });

    // 失败路径：auditError REGIME_SWITCH_FAILED、hash 不更新（D7 自愈）、state 不动
    expect(audit.events.some(e => e[0] === RUNTIME_AUDIT_EVENTS.REGIME_SWITCH_FAILED)).toBe(true);
    expect(audit.events.some(e => e[0] === RUNTIME_AUDIT_EVENTS.REGIME_SWITCH_COMMITTED)).toBe(false);
    expect(runtime.testGetLastIdentityHash()).toBe('identity-A');
    expect(ctx.readFileState.size).toBe(1);
    expect(await diskStateExists()).toBe(true);
  });
});
