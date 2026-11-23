/** Whole-configuration connection checks and the primary repair compatibility entry. */
import type * as readline from 'readline';
import type { LLMConfigurationAdmin, LLMConfigSnapshot } from '../core/llm-configuration/index.js';
import {
  createAuthenticationCapability,
  snapshotLLMConfig,
} from '../core/llm-configuration/index.js';
import { createAuthenticationSetup } from '../core/llm-configuration/setup.js';
import type { FileSystem } from '../foundation/fs/index.js';
import {
  probeLLMConnection,
  type LLMErrorType,
} from './llm-probe.js';
import { repairProviderSlot } from './provider-repair.js';

export {
  LLM_ERROR_HINTS,
  LLM_ERROR_LABELS,
  LLM_REPAIR_ACTIONS,
  checkLLMConnectionFor,
  classifyLLMErrorForDisplay,
  createProbeProviderFactory,
  formatLLMError,
  probeLLMConnection,
  summarizeLLMFailure,
} from './llm-probe.js';
export type {
  LLMErrorType,
  LLMFailureSummary,
  LLMProbeOptions,
  LLMRepairAction,
} from './llm-probe.js';

export interface VerifiedLLMConfig {
  snapshot: LLMConfigSnapshot;
  probe: { model: string };
  via: 'init' | 'start';
}

interface LLMConfigDeps {
  fsFactory: (baseDir: string) => FileSystem;
  llmConfiguration: Pick<LLMConfigurationAdmin, 'loadGlobal' | 'loadRaw' | 'store'> &
    Partial<Pick<LLMConfigurationAdmin, 'migrateLegacyApiKeys'>>;
}

export async function checkLLMConnection(deps: LLMConfigDeps): Promise<
  { ok: true; model: string; identity: string } |
  { ok: false; errorType: LLMErrorType; message: string; provider: string; identity: string }
> {
  const authentication = createAuthenticationSetup({ fsFactory: deps.fsFactory });
  const snapshot = snapshotLLMConfig(deps.llmConfiguration.loadGlobal(), undefined, {
    credentials: createAuthenticationCapability({ fsFactory: deps.fsFactory }),
  });
  return probeLLMConnection(snapshot, { authentication });
}

/** Repair only the current primary; callers must re-read the full snapshot before runtime use. */
export async function promptReconfigure(
  deps: LLMConfigDeps,
  rl: readline.Interface,
  _errorType: LLMErrorType,
): Promise<LLMConfigSnapshot | null> {
  const outcome = await repairProviderSlot(deps, { role: 'primary' }, rl);
  return outcome.kind === 'committed' ? outcome.verified.snapshot : null;
}
