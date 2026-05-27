import * as path from 'path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { Snapshot } from '../../src/foundation/snapshot/index.js';
import { SNAPSHOT_IGNORE_PATTERNS } from '../../src/assembly/snapshot-patterns.js';

import { DialogStore, createDialogStore } from '../../src/foundation/dialog-store/index.js';
import { InboxReader, OutboxWriter } from '../../src/foundation/messaging/index.js';
import { createOutboxWriter } from '../../src/foundation/messaging/index.js';
import { LLMOrchestratorImpl } from '../../src/foundation/llm-orchestrator/orchestrator.js';
import { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import { ToolExecutorImpl } from '../../src/foundation/tools/executor.js';
import { createSkillSystem } from '../../src/foundation/skill-system/index.js';
import { createClawPermissionChecker } from '../../src/core/permissions/claw-permissions.js';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { AsyncTaskSystem } from '../../src/core/async-task-system/system.js';
import { ContextInjector } from '../../src/core/dialog/injector.js';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import type { RuntimeDependencies } from '../../src/core/runtime/index.js';
import type { LLMOrchestratorConfig } from '../../src/foundation/llm-orchestrator/types.js';
import { INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR } from '../../src/foundation/messaging/dirs.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { TEST_LLM_TIMEOUT_MS } from './test-timeouts.js';

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
  const sessionManager = new DialogStore(systemFs, 'dialog', auditWriter, 'current.json', clawId);
  const inboxReader = new InboxReader(INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR, systemFs, auditWriter);
  const outboxWriter = createOutboxWriter(clawId, clawDir, systemFs, auditWriter);
  const llm = new LLMOrchestratorImpl(input.llmConfig ?? {
    primary: { name: 'mock', apiKey: 'test', model: 'test', maxTokens: 1024, temperature: 0.7, timeoutMs: TEST_LLM_TIMEOUT_MS, apiFormat: 'anthropic' },
    maxAttempts: 1,
    retryDelayMs: 100,
    events: { emit: () => {} },
  });
  const toolRegistry = new ToolRegistryImpl();
  const skillRegistry = createSkillSystem(systemFs, 'skills');
  const verifierRegistry = new ToolRegistryImpl();
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
  const contractManager = new ContractSystem({
    clawDir,
    clawId,
    fs: systemFs,
    audit: auditWriter,
    llm,
    toolRegistry: verifierRegistry,
    fsFactory
  });
  const taskSystem = new AsyncTaskSystem(clawDir, systemFs, {
    auditWriter, llm, contractManager, outboxWriter, registry: toolRegistry,
  });
  const toolExecutor = new ToolExecutorImpl(toolRegistry, 60000);
  const permissionChecker = createClawPermissionChecker({ clawDir, strict: true, audit: auditWriter, fs: clawFs });

  return {
    systemFs, clawFs, auditWriter, snapshot, sessionManager,
    inboxReader, outboxWriter, llm, toolRegistry, toolExecutor,
    skillRegistry, contractManager, taskSystem,
    permissionChecker,
    parentStreamLog: undefined,
    contractNotifyCallback: undefined,
    // phase 521 mock
    dialogStoreFactory: (systemPrompt: string) => {
      return createDialogStore(systemFs, 'dialog', auditWriter, 'current.json', clawId);
    },
  };
}
