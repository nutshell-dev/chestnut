import * as path from 'path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import type { AuditLog } from '../../src/foundation/audit/types.js';
import { Snapshot } from '../../src/foundation/snapshot/index.js';
import { SNAPSHOT_IGNORE_PATTERNS } from '../../src/assembly/config/snapshot-patterns.js';

import { DialogStore, createDialogStore } from '../../src/foundation/dialog-store/index.js';
import { InboxReader } from '../../src/foundation/messaging/index.js';
import { LLMOrchestratorImpl } from '../../src/foundation/llm-orchestrator/orchestrator.js';
import { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import { ToolExecutorImpl } from '../../src/foundation/tools/executor.js';
import { createSkillSystem } from '../../src/foundation/skill-system/index.js';
import { initializeClawLayout } from '../../src/assembly/index.js';
import { createClawPermissionChecker } from '../../src/core/permissions/claw-permissions.js';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { AsyncTaskSystem } from '../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../src/core/async-task-system/short-id-index.js';
import { ContextInjector } from '../../src/core/runtime/injector.js';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import type { RuntimeDependencies } from '../../src/core/runtime/index.js';
import type { LLMOrchestratorConfig } from '../../src/foundation/llm-orchestrator/types.js';
import { INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR } from '../../src/foundation/messaging/dirs.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
// phase 1243: formatter registry + 业主自家 rendering declarations
import {
  createInboxMessageTypeRegistry,
  registerInboxMessageTypes,
  MESSAGING_INBOX_MESSAGE_TYPES,
} from '../../src/foundation/messaging/index.js';
import { GATEWAY_INBOX_MESSAGE_TYPES } from '../../src/core/gateway/index.js';
import { WATCHDOG_INBOX_MESSAGE_TYPES } from '../../src/watchdog/inbox-formatter.js';
import { createHeartbeatInboxFormatter } from '../../src/core/heartbeat/index.js';
import { TEST_LLM_TIMEOUT_MS } from './test-timeouts.js';

const TEST_CLAW_ID = 'test-claw';

interface MakeRuntimeDepsInput {
  clawId?: string;
  clawDir: string;
  llmConfig?: LLMOrchestratorConfig;
  /**
   * Optional AuditLog override (phase 379): tests can inject a mock audit to
   * assert on call args directly instead of reading audit.tsv from disk.
   * If omitted, defaults to a real AuditWriter writing to <clawDir>/audit.tsv.
   */
  auditOverride?: AuditLog;
}

export async function makeRuntimeDeps(input: MakeRuntimeDepsInput): Promise<RuntimeDependencies> {
  const { clawDir, clawId = TEST_CLAW_ID } = input;
  const systemFs = new NodeFileSystem({ baseDir: clawDir });
  initializeClawLayout(systemFs);
  const clawFs = new NodeFileSystem({ baseDir: clawDir });
  const auditWriter = input.auditOverride ?? new AuditWriter(systemFs, 'audit.tsv', null);
  const snapshot = new Snapshot(clawDir, systemFs, auditWriter, SNAPSHOT_IGNORE_PATTERNS);
  const sessionManager = new DialogStore(systemFs, 'dialog', auditWriter, 'current.json', clawId);
  const inboxReader = new InboxReader(INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR, systemFs, auditWriter);
  const llm = new LLMOrchestratorImpl(input.llmConfig ?? {
    primary: { name: 'mock', apiKey: 'test', model: 'test', maxTokens: 1024, temperature: 0.7, timeoutMs: TEST_LLM_TIMEOUT_MS, apiFormat: 'anthropic' },
    maxAttempts: 1,
    retryDelayMs: 100,
    events: { emit: () => {} },
  });
  const toolRegistry = new ToolRegistryImpl();
  const skillRegistry = createSkillSystem(systemFs, 'skills', auditWriter);
  const verifierRegistry = new ToolRegistryImpl();
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
  const contractManager = new ContractSystem({
    clawDir,
    clawId,
    fs: systemFs,
    audit: auditWriter,
    llm,
    toolRegistry: verifierRegistry,
    fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: () => {},});
  const taskSystem = new AsyncTaskSystem(clawDir, systemFs, {
    auditWriter, llm, contractManager, registry: toolRegistry,
    shortIdIndex: new InMemoryShortIdIndex(),
  });
  const toolExecutor = new ToolExecutorImpl(toolRegistry, 60000);
  const permissionChecker = createClawPermissionChecker({ clawDir, strict: true, audit: auditWriter, fs: clawFs });

  // phase 1243: formatter registry + 业主 rendering declarations（test 装配 = motion 全开）
  const formatterRegistry = createInboxMessageTypeRegistry();
  registerInboxMessageTypes(formatterRegistry, MESSAGING_INBOX_MESSAGE_TYPES);
  registerInboxMessageTypes(formatterRegistry, GATEWAY_INBOX_MESSAGE_TYPES);
  registerInboxMessageTypes(formatterRegistry, WATCHDOG_INBOX_MESSAGE_TYPES);
  formatterRegistry.register({
    owner: 'motion-heartbeat-test',
    type: 'heartbeat',
    rendering: {
      kind: 'custom',
      formatter: createHeartbeatInboxFormatter({ systemFs, audit: auditWriter }),
    },
  });

  return {
    systemFs, clawFs, auditWriter, snapshot, sessionManager,
    inboxReader, llm, toolRegistry, toolExecutor,
    skillRegistry, contractManager, taskSystem,
    permissionChecker,
    // phase 521 mock
    dialogStoreFactory: (systemPrompt: string) => {
      return createDialogStore(systemFs, 'dialog', auditWriter, 'current.json', clawId);
    },
    formatterRegistry,
  };
}
