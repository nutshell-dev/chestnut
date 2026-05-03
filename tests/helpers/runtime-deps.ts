import * as path from 'path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { Snapshot, SNAPSHOT_IGNORE_PATTERNS } from '../../src/foundation/snapshot/index.js';
import { createClawPermissionChecker } from '../../src/core/permissions/claw-permissions.js';
import { SessionManager } from '../../src/foundation/session-store/index.js';
import { InboxReader, OutboxWriter } from '../../src/foundation/messaging/index.js';
import { LLMOrchestratorImpl } from '../../src/foundation/llm-orchestrator/orchestrator.js';
import { ToolRegistryImpl } from '../../src/core/tools/registry.js';
import { ToolExecutorImpl } from '../../src/core/tools/executor.js';
import { createSkillRegistry } from '../../src/core/skill/index.js';
import { ContractManager } from '../../src/core/contract/manager.js';
import { TaskSystem } from '../../src/core/task/system.js';
import { ContextInjector } from '../../src/core/dialog/injector.js';
import { ExecContextImpl } from '../../src/core/tools/context.js';
import { registerBuiltinTools } from '../../src/core/tools/builtins/index.js';
import type { RuntimeDependencies } from '../../src/core/runtime/index.js';
import type { LLMOrchestratorConfig } from '../../src/foundation/llm-orchestrator/types.js';
import { INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR } from '../../src/types/paths.js';

export const TEST_CLAW_ID = 'test-claw';

export interface MakeRuntimeDepsInput {
  clawId?: string;
  clawDir: string;
  llmConfig?: LLMOrchestratorConfig;
}

export async function makeRuntimeDeps(input: MakeRuntimeDepsInput): Promise<RuntimeDependencies> {
  const { clawDir, clawId = TEST_CLAW_ID } = input;
  const systemFs = new NodeFileSystem({ baseDir: clawDir });
  const clawFs = new NodeFileSystem(
    { baseDir: clawDir },
    createClawPermissionChecker({ clawDir, strict: true }),
  );
  const auditWriter = new AuditWriter(systemFs, 'audit.tsv', null);
  const snapshot = new Snapshot(clawDir, systemFs, auditWriter, SNAPSHOT_IGNORE_PATTERNS);
  await snapshot.init();
  const sessionManager = new SessionManager(systemFs, 'dialog', auditWriter, clawId);
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
  registerBuiltinTools(toolRegistry);
  const skillRegistry = createSkillRegistry(systemFs, 'skills');
  await skillRegistry.loadAll();
  const verifierRegistry = new ToolRegistryImpl();
  const contractManager = new ContractManager(
    clawDir, clawId, systemFs, auditWriter, llm, verifierRegistry, auditWriter,
  );
  const taskSystem = new TaskSystem(clawDir, systemFs, {
    auditWriter, llm, contractManager, outboxWriter,
  });
  await taskSystem.initialize();
  taskSystem.startDispatch();
  const contextInjector = new ContextInjector({ fs: systemFs, skillRegistry, contractManager });
  const execContext = new ExecContextImpl({
    clawId, clawDir, profile: 'full', callerType: 'claw', fs: clawFs,
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
  };
}
