import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runDeepDream, type DeepDreamOptions } from '../../../src/core/memory/deep-dream.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { LLMOrchestratorConfig } from '../../../src/foundation/llm-orchestrator/types.js';
import { createClawTopology } from '../../../src/core/claw-topology/topology.js';
import { makeClawId } from '../../../src/foundation/claw-identity/claw-id.js';

// ─── LLMOrchestrator mock ──────────────────────────────────────────
const mockLlmCall = vi.fn();

const mockLlmService = {
  call: mockLlmCall,
  stream: vi.fn(),
  healthCheck: vi.fn(),
  getProviderInfo: vi.fn(),
  close: vi.fn(),
};

const fakeLlmConfig: LLMOrchestratorConfig = {
  primary: { name: 'test', apiKey: 'sk-test', model: 'claude-test' } as any,
};

const mockAudit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};

function makeTextResponse(text: string) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

function makeTopology(chestnutRoot: string) {
  return createClawTopology({
    fs: new NodeFileSystem({ baseDir: chestnutRoot }),
    chestnutRoot,
    motionClawId: makeClawId('motion'),
    motionDir: 'motion',
  });
}

function makeOpts(overrides: Partial<DeepDreamOptions> & { chestnutRoot?: string } = {}): DeepDreamOptions {
  const chestnutRoot = overrides.chestnutRoot ?? '';
  return {
    clawsDir: chestnutRoot ? `${chestnutRoot}/claws` : '',
    clawTopology: makeTopology(chestnutRoot),
    llmConfig: fakeLlmConfig,
    llmService: mockLlmService as any,
    fs: new NodeFileSystem({ baseDir: chestnutRoot }),
    audit: mockAudit,
    clawFsFactory: (clawDir) => new NodeFileSystem({ baseDir: clawDir }),
    ...overrides,
  };
}

// ─── 测试 ─────────────────────────────────────────────────────

describe('runDeepDream — clawFsFactory 注入路径（caller DIP enforce）', () => {
  beforeEach(() => {
    mockLlmCall.mockReset();
    mockLlmCall.mockResolvedValue(makeTextResponse('dream output'));
    mockAudit.write.mockClear();
  });

  it('多 claw 迭代各自调 factory（per-claw dynamic）', async () => {
    const chestnutDir = path.join(os.tmpdir(), `phase609-dd-${randomUUID()}`);
    const clawsDir = path.join(chestnutDir, 'claws');

    for (const clawId of ['a', 'b', 'c']) {
      const clawDir = path.join(clawsDir, clawId);
      await fs.mkdir(path.join(clawDir, 'dialog', 'archive'), { recursive: true });
      await fs.mkdir(path.join(clawDir, 'inbox', 'pending'), { recursive: true });
    }

    const factory = vi.fn().mockImplementation((clawDir: string) => new NodeFileSystem({ baseDir: clawDir }));

    await runDeepDream(makeOpts({ chestnutRoot: chestnutDir, clawFsFactory: factory }));

    expect(factory).toHaveBeenCalledTimes(3);
    expect(factory).toHaveBeenCalledWith(path.join(clawsDir, 'a'));
    expect(factory).toHaveBeenCalledWith(path.join(clawsDir, 'b'));
    expect(factory).toHaveBeenCalledWith(path.join(clawsDir, 'c'));

    await fs.rm(chestnutDir, { recursive: true, force: true });
  });

  it('clawIds 空时 factory 0 call', async () => {
    const chestnutDir = path.join(os.tmpdir(), `phase609-dd-empty-${randomUUID()}`);
    await fs.mkdir(path.join(chestnutDir, 'claws'), { recursive: true });

    const factory = vi.fn().mockImplementation((clawDir: string) => new NodeFileSystem({ baseDir: clawDir }));

    await runDeepDream(makeOpts({ chestnutRoot: chestnutDir, clawFsFactory: factory }));

    expect(factory).not.toHaveBeenCalled();

    await fs.rm(chestnutDir, { recursive: true, force: true });
  });

  it('factory 抛错时单 claw 失败不阻断其他 claw（既有契约保持）', async () => {
    const chestnutDir = path.join(os.tmpdir(), `phase609-dd-fail-${randomUUID()}`);
    const clawsDir = path.join(chestnutDir, 'claws');

    for (const clawId of ['ok1', 'fail', 'ok2']) {
      const clawDir = path.join(clawsDir, clawId);
      await fs.mkdir(path.join(clawDir, 'dialog', 'archive'), { recursive: true });
      await fs.mkdir(path.join(clawDir, 'inbox', 'pending'), { recursive: true });
    }

    let callCount = 0;
    const factory = vi.fn().mockImplementation((clawDir: string): FileSystem => {
      callCount++;
      if (path.basename(clawDir) === 'fail') {
        throw new Error('factory-fail-for-claw-fail');
      }
      return new NodeFileSystem({ baseDir: clawDir });
    });

    await runDeepDream(makeOpts({ chestnutRoot: chestnutDir, clawFsFactory: factory }));

    expect(factory).toHaveBeenCalledTimes(3);
    expect(factory).toHaveBeenCalledWith(path.join(clawsDir, 'ok1'));
    expect(factory).toHaveBeenCalledWith(path.join(clawsDir, 'fail'));
    expect(factory).toHaveBeenCalledWith(path.join(clawsDir, 'ok2'));

    // audit 记录 DEEP_DREAM_UNEXPECTED for claw-fail
    expect(mockAudit.write).toHaveBeenCalledWith(
      'deep_dream_unexpected',
      'step=unexpected',
      'clawId=fail',
      'reason=factory-fail-for-claw-fail',
    );

    await fs.rm(chestnutDir, { recursive: true, force: true });
  });
});
