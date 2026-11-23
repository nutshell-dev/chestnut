import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import {
  createLLMConfigurationDocumentStore,
  getLLMConfigurationPath,
  snapshotLLMConfigInput,
  executeLLMSetupAttempt,
  runLLMSetupWorkflow,
  LLMSetupCommittedObserverError,
  type LLMSetupDraft,
  type LLMSetupProbeResult,
  type LLMSetupWorkflowEvent,
} from '../../../src/core/llm-configuration/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { cleanupTempDirSync, createTrackedTempDirSync } from '../../utils/temp.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
let homeDir: string;
let projectDir: string;

beforeEach(() => {
  homeDir = createTrackedTempDirSync('chestnut-setup-workflow-home-');
  projectDir = createTrackedTempDirSync('chestnut-setup-workflow-project-');
  vi.stubEnv('CHESTNUT_HOME', homeDir);
  vi.stubEnv('CHESTNUT_ROOT', projectDir);
  vi.stubEnv('SETUP_WORKFLOW_TEST_KEY', 'resolved-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirSync(homeDir);
  cleanupTempDirSync(projectDir);
});

function provider(model: string, baseUrl = 'https://direct.example.test') {
  return {
    provider_id: 'custom:anthropic' as const,
    api_format: 'anthropic' as const,
    auth_profile: 'api_key' as const,
    api_key: '${SETUP_WORKFLOW_TEST_KEY}',
    model,
    base_url: baseUrl,
  };
}

function success(draft: LLMSetupDraft): LLMSetupProbeResult {
  return {
    ok: true,
    model: draft.provider.model,
    snapshot: snapshotLLMConfigInput({ llm: { primary: draft.provider } }),
  };
}

function failure(message = 'failed'): LLMSetupProbeResult {
  return { ok: false, errorType: 'network', message, provider: 'custom:anthropic' };
}

describe('LLM setup workflow', () => {
  it('候选按序首胜即停，提交 winner 显式文档并留下无 secret 的结果/时间/winner 事件', async () => {
    const store = createLLMConfigurationDocumentStore({ fsFactory });
    const events: LLMSetupWorkflowEvent[] = [];
    const probed: string[] = [];
    const outcome = await executeLLMSetupAttempt({
      store,
      probe: async (draft) => {
        probed.push(draft.provider.base_url ?? '');
        return draft.provider.base_url?.includes('winner') ? success(draft) : failure();
      },
      recheckIdentity: async () => true,
      emit: event => events.push(event),
    }, {
      provider: provider('model'),
      candidates: [
        { identity: 'candidate-a', config: provider('model', 'https://a.example.test') },
        { identity: 'candidate-b', config: provider('model', 'https://winner.example.test') },
        { identity: 'candidate-c', config: provider('model', 'https://not-called.example.test') },
      ],
    }, { kind: 'initialize' });

    expect(outcome.kind).toBe('committed');
    expect(probed).toEqual([
      'https://a.example.test',
      'https://winner.example.test',
      'https://winner.example.test',
    ]);
    expect(store.read().primary.base_url).toBe('https://winner.example.test');
    if (outcome.kind === 'committed') {
      expect(outcome.commit.revision.revision).toBe(1);
      expect(outcome.candidates.map(candidate => candidate.winner)).toEqual([false, true, true]);
      expect(outcome.candidates.every(candidate => candidate.startedAt && candidate.completedAt)).toBe(true);
    }
    expect(JSON.stringify(events)).not.toContain('resolved-secret');
    expect(JSON.stringify(events)).not.toContain('SETUP_WORKFLOW_TEST_KEY');
  });

  it('全败进入同一 cancel 语义，零配置写入且保留所有候选结果', async () => {
    const store = createLLMConfigurationDocumentStore({ fsFactory });
    const outcome = await runLLMSetupWorkflow({
      store,
      probe: async () => failure(),
      recheckIdentity: async () => true,
    }, {
      provider: provider('model'),
      candidates: [
        { identity: 'a', config: provider('model', 'https://a.example.test') },
        { identity: 'b', config: provider('model', 'https://b.example.test') },
      ],
    }, { kind: 'initialize' }, async (attempt) => {
      expect(attempt.candidates).toHaveLength(2);
      return { kind: 'cancel', reason: 'test_cancel' };
    });

    expect(outcome).toEqual({ kind: 'cancelled', reason: 'test_cancel' });
    expect(fs.existsSync(getLLMConfigurationPath())).toBe(false);
  });

  it('repair 替换 draft 后只提交重新 probe 的配置；identity 漂移 fail closed', async () => {
    const store = createLLMConfigurationDocumentStore({ fsFactory });
    const outcome = await runLLMSetupWorkflow({
      store,
      probe: async draft => draft.provider.model === 'fixed' ? success(draft) : failure(),
      recheckIdentity: async () => true,
    }, { provider: provider('broken') }, { kind: 'initialize' }, async () => ({
      kind: 'repair', draft: { provider: provider('fixed') },
    }));
    expect(outcome.kind).toBe('committed');
    expect(store.read().primary.model).toBe('fixed');

    const other = createLLMConfigurationDocumentStore({ fsFactory });
    await expect(executeLLMSetupAttempt({
      store: other,
      probe: async draft => success(draft),
      recheckIdentity: async () => false,
    }, { provider: provider('other') }, { kind: 'initialize' })).rejects.toThrow(/fail-closed/);
    expect(other.read().primary.model).toBe('fixed');
  });

  it('committed 审计/观察事件异常保留已提交回执与原 cause', async () => {
    const store = createLLMConfigurationDocumentStore({ fsFactory });
    let thrown: unknown;
    try {
      await executeLLMSetupAttempt({
        store,
        probe: async draft => success(draft),
        recheckIdentity: async () => true,
        emit: event => {
          if (event.type === 'committed') throw new Error('committed audit failed');
        },
      }, { provider: provider('committed') }, { kind: 'initialize' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LLMSetupCommittedObserverError);
    if (!(thrown instanceof LLMSetupCommittedObserverError)) throw new Error('expected committed observer error');
    expect(thrown.commit.revision.revision).toBe(1);
    expect(thrown.commit.document.primary.model).toBe('committed');
    expect(thrown.cause).toMatchObject({ message: 'committed audit failed' });
    expect(store.read().primary.model).toBe('committed');
  });

  it('缺显式字段或 preset 草稿在 probe/commit 前拒绝', async () => {
    let probes = 0;
    const store = createLLMConfigurationDocumentStore({ fsFactory });
    await expect(executeLLMSetupAttempt({
      store,
      probe: async draft => { probes++; return success(draft); },
      recheckIdentity: async () => true,
    }, {
      provider: { preset: 'anthropic', model: 'claude' },
    } as unknown as LLMSetupDraft, { kind: 'initialize' })).rejects.toThrow();
    expect(probes).toBe(0);
    expect(fs.existsSync(getLLMConfigurationPath())).toBe(false);
  });
});
