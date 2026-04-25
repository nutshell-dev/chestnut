import * as path from 'path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { Snapshot, SNAPSHOT_IGNORE_PATTERNS } from '../../src/foundation/snapshot/index.js';
import { SessionManager } from '../../src/foundation/session-store/index.js';
import { InboxReader, OutboxWriter } from '../../src/foundation/messaging/index.js';
import { JsonlLogger } from '../../src/foundation/monitor/monitor.js';
import { LLMServiceImpl } from '../../src/foundation/llm/service.js';
import { ToolRegistryImpl } from '../../src/core/tools/registry.js';
import { ToolExecutorImpl } from '../../src/core/tools/executor.js';
import { createSkillRegistry } from '../../src/core/skill/index.js';
import { ContractManager } from '../../src/core/contract/manager.js';
import { TaskSystem } from '../../src/core/task/system.js';
import { ContextInjector } from '../../src/core/dialog/injector.js';
import { ExecContextImpl } from '../../src/core/tools/context.js';
import { registerBuiltinTools } from '../../src/core/tools/builtins/index.js';
import type { RuntimeDependencies } from '../../src/core/runtime.js';
import type { LLMServiceConfig } from '../../src/foundation/llm/types.js';

export const TEST_CLAW_ID = 'test-claw';

export interface MakeRuntimeDepsInput {
  clawId?: string;
  clawDir: string;
  llmConfig?: LLMServiceConfig;
}

export async function makeRuntimeDeps(input: MakeRuntimeDepsInput): Promise<RuntimeDependencies> {
  const { clawDir, clawId = TEST_CLAW_ID } = input;
  const systemFs = new NodeFileSystem({ baseDir: clawDir, enforcePermissions: false });
  const clawFs = new NodeFileSystem({ baseDir: clawDir, enforcePermissions: true });
  const auditWriter = new AuditWriter(systemFs, 'audit.tsv', null);
  const snapshot = new Snapshot(clawDir, systemFs, auditWriter, SNAPSHOT_IGNORE_PATTERNS);
  await snapshot.init();
  const sessionManager = new SessionManager(systemFs, 'dialog', auditWriter, clawId);
  const inboxReader = new InboxReader('inbox/pending', 'inbox/done', 'inbox/failed', systemFs, auditWriter);
  await inboxReader.init();
  const outboxWriter = new OutboxWriter(clawId, clawDir, systemFs, auditWriter);
  const monitor = new JsonlLogger({ logsDir: path.join(clawDir, 'logs') });
  const llm = new LLMServiceImpl(input.llmConfig ?? {
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
    auditWriter, llm, skillRegistry, contractManager, outboxWriter,
  });
  await taskSystem.initialize();
  taskSystem.startDispatch();
  const contextInjector = new ContextInjector({ fs: systemFs, skillRegistry, contractManager });
  const execContext = new ExecContextImpl({
    clawId, clawDir, profile: 'full', callerType: 'claw', fs: clawFs,
    monitor, llm, maxSteps: 30, taskSystem, skillRegistry, contractManager,
    outboxWriter, auditWriter,
  });
  const toolExecutor = new ToolExecutorImpl(toolRegistry, 60000);

  return {
    systemFs, clawFs, auditWriter, snapshot, sessionManager,
    inboxReader, outboxWriter, monitor, llm, toolRegistry, toolExecutor,
    skillRegistry, contractManager, taskSystem, contextInjector, execContext,
    parentStreamLog: undefined,
    contractNotifyCallback: undefined,
  };
}
