/** The single interactive LLM configuration editor used by start and provider add. */
import type * as readline from 'node:readline';
import { CliError } from './errors.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { formatErr } from '../foundation/node-utils/index.js';
import { createAuthenticationSetup } from '../core/llm-configuration/setup.js';
import { storeKeyAsCredential } from './credentials-prompt.js';
import { passwordQuestion } from './utils/password-prompt.js';
import { FORMAT_MAP } from './provider-format-map.js';
import {
  SETUP_PROVIDER_CATALOG,
  createExplicitSetupDraft,
  describeEffectiveThinking,
  isCustomSetupChoice,
  type ExplicitSetupDraft,
  type SetupProviderChoice,
} from './setup-provider-catalog.js';
import {
  SETUP_WELCOME,
  SETUP_OTHER_FORMAT_LINES,
  SETUP_CONFIRM_PROMPT,
  setupApiKeyPrompt,
  setupCredentialCleanupFailedLine,
  setupCredentialDiscardedLine,
  setupProviderMenuLines,
  setupDraftPreviewLines,
} from '../templates/messages/index.js';
import type { LLMRepairAction } from './llm-repair-action.js';

export interface LLMConfigEditorDeps {
  fsFactory(baseDir: string): FileSystem;
}

export type Question = (prompt: string, defaultValue?: string) => Promise<string>;

export interface StoredCredential {
  ref: string;
  value: string;
}

export function recordCreatedCredential(
  created: StoredCredential[],
  ref: string,
  info: { created: boolean; value: string },
): void {
  const existing = created.find(entry => entry.ref === ref);
  if (existing) {
    existing.value = info.value;
    return;
  }
  if (info.created) created.push({ ref, value: info.value });
}

/** Remove only credentials created by this attempt and still holding its value. */
export async function discardCreatedCredentials(
  deps: LLMConfigEditorDeps,
  created: readonly StoredCredential[],
  emit = true,
): Promise<void> {
  if (created.length === 0) return;
  const authentication = createAuthenticationSetup({ fsFactory: deps.fsFactory });
  for (const { ref, value } of created) {
    let removed = false;
    try {
      await authentication.modify(ref, async (current) => {
        if (current === value) {
          removed = true;
          return undefined;
        }
        return current;
      });
      if (emit && removed) console.log(setupCredentialDiscardedLine());
    } catch (err) {
      if (emit) console.log(setupCredentialCleanupFailedLine(formatErr(err)));
    }
  }
}

export type ExplicitLLMConfigResult =
  | { kind: 'collected'; draft: ExplicitSetupDraft }
  | { kind: 'cancelled'; reason: 'user_cancelled' };

export interface LLMConfigEditorOptions {
  /** Provider-add uses a unique scope so a new label never overwrites another key. */
  credentialSeed?: string;
}

export async function storeSetupApiKey(
  deps: LLMConfigEditorDeps,
  rawKey: string,
  choice: SetupProviderChoice,
  created: StoredCredential[],
  silent = false,
  credentialSeed?: string,
): Promise<string> {
  if (!rawKey) throw new CliError('API Key is required');
  const envReady = Boolean(choice.envVar && process.env[choice.envVar]);
  const storeCtx = credentialSeed !== undefined
    ? { seed: credentialSeed, onShadowedEnv: 'error' as const }
    : envReady
      ? { seed: choice.id, onShadowedEnv: 'error' as const }
      : { envVar: choice.envVar, seed: choice.id, onShadowedEnv: 'error' as const };
  return storeKeyAsCredential(deps, rawKey, storeCtx, {
    onStored: (ref, info) => recordCreatedCredential(created, ref, info),
    silent,
  });
}

async function promptApiKey(
  deps: LLMConfigEditorDeps,
  rl: readline.Interface,
  draft: Pick<ExplicitSetupDraft, 'choice' | 'authProfile'>,
  created: StoredCredential[],
  options: LLMConfigEditorOptions = {},
): Promise<string | undefined> {
  const { choice, authProfile } = draft;
  if (authProfile !== 'api_key') {
    console.log(`ℹ ${choice.label}: ${authProfile} authentication, no API key input required.`);
    return undefined;
  }
  const envVar = choice.envVar;
  const envReady = Boolean(envVar && process.env[envVar]);
  const rawKey = await passwordQuestion(rl, `${setupApiKeyPrompt(envReady ? envVar : undefined)}: `);
  if (!rawKey && envReady && envVar) {
    console.log(`✓ Will read from ${envVar} at runtime`);
    return '${' + envVar + '}';
  }
  return storeSetupApiKey(deps, rawKey, choice, created, false, options.credentialSeed);
}

async function promptModel(
  choice: SetupProviderChoice,
  question: Question,
): Promise<string> {
  const model = await question('Model', choice.defaultModel || undefined);
  if (!model) throw new CliError('Model is required');
  return model;
}

function confirmCustomDraft(draft: ExplicitSetupDraft, question: Question): Promise<boolean> {
  const thinking = describeEffectiveThinking(draft.choice, draft.model);
  setupDraftPreviewLines({
    label: draft.choice.label,
    model: draft.model,
    auth: draft.authProfile === 'api_key' ? 'API key' : draft.authProfile,
    ...(thinking !== undefined && { thinking }),
    ...(draft.baseUrl !== undefined && { baseUrl: draft.baseUrl }),
    ...(draft.apiKey !== undefined && { keyRef: draft.apiKey }),
  }).forEach(line => console.log(line));
  return question(`\n${SETUP_CONFIRM_PROMPT}`, 'Y').then(answer => answer.toLowerCase() !== 'n');
}

async function selectConfigurationMethod(question: Question): Promise<SetupProviderChoice> {
  console.log(SETUP_WELCOME.trimEnd());
  setupProviderMenuLines(SETUP_PROVIDER_CATALOG).forEach(line => console.log(line));
  for (;;) {
    const raw = await question('\n> ');
    const index = Number.parseInt(raw, 10) - 1;
    const choice = SETUP_PROVIDER_CATALOG[index];
    if (choice) return choice;
    console.log('Invalid choice.');
  }
}

/** Collect, preview and confirm one explicit draft without any commit target context. */
export async function collectExplicitLLMConfig(
  deps: LLMConfigEditorDeps,
  rl: readline.Interface,
  question: Question,
  created: StoredCredential[],
  options: LLMConfigEditorOptions = {},
): Promise<ExplicitLLMConfigResult> {
  const choice = await selectConfigurationMethod(question);
  let apiFormat: ExplicitSetupDraft['apiFormat'] | undefined;
  let baseUrl: string | undefined;
  if (isCustomSetupChoice(choice)) {
    SETUP_OTHER_FORMAT_LINES.forEach(line => console.log(line));
    const format = await question('\n> ', '2');
    apiFormat = FORMAT_MAP[format];
    if (!apiFormat) throw new CliError('Invalid API format');
    baseUrl = await question('Base URL');
    if (!baseUrl) throw new CliError('Base URL is required');
  }

  const authProfile = choice.authProfile ?? 'api_key';
  const apiKey = await promptApiKey(deps, rl, { choice, authProfile }, created, options);
  const model = await promptModel(choice, question);
  const draft = createExplicitSetupDraft(choice, {
    ...(apiKey !== undefined && { apiKey }),
    model,
    ...(baseUrl !== undefined && { baseUrl }),
    ...(apiFormat !== undefined && { apiFormat }),
    authProfile,
  });
  if (isCustomSetupChoice(choice) && !(await confirmCustomDraft(draft, question))) {
    return { kind: 'cancelled', reason: 'user_cancelled' };
  }
  return { kind: 'collected', draft };
}

/** Shared repair editor; entry points only adapt the returned draft to their target. */
export async function repairExplicitLLMConfig(
  action: Exclude<LLMRepairAction, 'retry' | 'cancel'>,
  deps: LLMConfigEditorDeps,
  rl: readline.Interface,
  question: Question,
  draft: ExplicitSetupDraft,
  created: StoredCredential[],
  options: LLMConfigEditorOptions = {},
): Promise<ExplicitLLMConfigResult> {
  if (action === 'edit-provider') return collectExplicitLLMConfig(deps, rl, question, created, options);

  if (action === 'edit-key') {
    const apiKey = await promptApiKey(deps, rl, draft, created, options);
    return {
      kind: 'collected',
      draft: {
        ...draft,
        ...(apiKey !== undefined ? { apiKey } : { apiKey: undefined }),
        ...(draft.choice.probeCandidates !== undefined && { baseUrl: undefined }),
      },
    };
  }

  const model = await promptModel(draft.choice, question);
  return {
    kind: 'collected',
    draft: {
      ...draft,
      model,
      ...(draft.choice.probeCandidates !== undefined && { baseUrl: undefined }),
    },
  };
}
