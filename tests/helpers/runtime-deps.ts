import * as path from 'path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { Snapshot, SNAPSHOT_IGNORE_PATTERNS } from '../../src/foundation/snapshot/index.js';

import { DialogStore, createDialogStore } from '../../src/foundation/dialog-store/index.js';
import { InboxReader, OutboxWriter } from '../../src/foundation/messaging/index.js';
import { LLMOrchestratorImpl } from '../../src/foundation/llm-orchestrator/orchestrator.js';
import { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import { ToolExecutorImpl } from '../../src/foundation/tools/executor.js';
import { createSkillSystem } from '../../src/foundation/skill-system/index.js';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { AsyncTaskSystem } from '../../src/core/async-task-system/system.js';
import { ContextInjector } from '../../src/core/dialog/injector.js';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import type { RuntimeDependencies } from '../../src/core/runtime/index.js';
import type { LLMOrchestratorConfig } from '../../src/foundation/llm-orchestrator/types.js';
import { INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR } from '../../src/types/paths.js';

const TEST_CLAW_ID = 'test-claw';

interface MakeRuntimeDepsInput {
  clawId?: string;
  clawDir: string;
  llmConfig?: LLMOrchestratorConfig;
}

export async function makeRuntimeDeps(input: MakeRuntimeDepsInput): Promise<RuntimeDependencies> {
  const { clawDir, clawId = TEST_CLAW_ID } = input;
  const systemFs = new NodeFileSystem({ baseDir: clawDir });
  const clawFs = new NodeFileSystem({ baseDir: clawDir });
  const auditWriter = new AuditWriter(systemFs, 'audit.tsv', null);
  const snapshot = new Snapshot(clawDir, systemFs, auditWriter, SNAPSHOT_IGNORE_PATTERNS);
  await snapshot.init();
  const sessionManager = new DialogStore(systemFs, 'dialog', auditWriter, 'current.json', 'test-system-prompt', clawId);
  const inboxReader = new InboxReader(INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR, systemFs, auditWriter);
  await inboxReader.init();
  const outboxWriter = new OutboxWriter(clawId, clawDir, systemFs, auditWriter);
  const llm = new LLMOrchestratorImpl(input.llmConfig ?? {
    primary: { name: 'mock', apiKey: 'test', model: 'test', maxTokens: 1024, temperature: 0.7, timeoutMs: 30000, apiFormat: 'anthropic' },
    maxAttempts: 1,
    retryDelayMs: 100,
    events: { emit: () => {} },
  });
  const toolRegistry = new ToolRegistryImpl();
  const skillRegistry = createSkillSystem(systemFs, 'skills');
  await skillRegistry.loadAll();
  const verifierRegistry = new ToolRegistryImpl();
  const contractManager = new ContractSystem(
    clawDir, clawId, systemFs, auditWriter, llm, verifierRegistry, auditWriter,
  );
  const taskSystem = new AsyncTaskSystem(clawDir, systemFs, {
    auditWriter, llm, contractManager, outboxWriter, registry: toolRegistry,
  });
  await taskSystem.initialize();
  taskSystem.startDispatch();
  const contextInjector = new ContextInjector({ fs: systemFs, skillRegistry, contractManager });
  const execContext = new ExecContextImpl({
    clawId, clawDir, workspaceDir: path.join(clawDir, 'clawspace'), profile: 'full', callerType: 'claw', fs: clawFs,
    llm, maxSteps: 30, taskSystem, contractManager,
    outboxWriter, auditWriter,
  });
  const toolExecutor = new ToolExecutorImpl(toolRegistry, 60000);

  return {
    systemFs, clawFs, auditWriter, snapshot, sessionManager,
    inboxReader, outboxWriter, llm, toolRegistry, toolExecutor,
    skillRegistry, contractManager, taskSystem, contextInjector, execContext,
    parentStreamLog: undefined,
    contractNotifyCallback: undefined,
    // phase 521 mock
    dialogStoreFactory: (systemPrompt: string) => {
      return createDialogStore(systemFs, 'dialog', auditWriter, 'current.json', systemPrompt, clawId);
    },
  };
}
