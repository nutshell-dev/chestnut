/**
 * config command - Manage LLM provider configuration
 */

import * as path from 'path';
import * as readline from 'readline';
import { Command } from 'commander';
import { loadGlobalConfig, saveGlobalConfig } from '../../assembly/config-load.js';
import type { ClawGlobalConfig } from '../../assembly/compose-config.js';
import type { LLMProviderConfig } from '../../foundation/llm-orchestrator/index.js';
import { PRESETS } from '../../foundation/config/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { CliError } from '../errors.js';
import { fitLine } from '../utils/string.js';
import { DEFAULT_TERMINAL_WIDTH } from '../utils/constants.js';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../foundation/llm-orchestrator/index.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { makeClawId } from '../../foundation/identity/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
// phase 320: hot-reload — CLI 投递 reload_llm_config 给运行中 daemon
import { notifyClaw } from '../../foundation/messaging/index.js';
import { CLAWS_DIR, enumerateClaws } from '../../foundation/claw-paths.js';
import { getChestnutRoot } from '../../foundation/install-paths.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { RELOAD_LLM_CONFIG_MESSAGE_TYPE } from '../../core/runtime/index.js';
import { toProviderConfig } from '../../foundation/llm-orchestrator/config-adapter.js';
import { checkLLMConnection, checkLLMConnectionFor, promptReconfigure, formatLLMError, LLM_ERROR_HINTS } from '../llm-connection-check.js';

/**
 * phase 320: 通知所有运行中的 daemon（motion + 所有 claws）重新加载 LLM 配置。
 * Producer 侧 / consumer 侧在 Runtime._drainOwnInbox 拦截路径。
 *
 * - daemon 不存活 → silent skip（下次启动自然读新配置）
 * - notifyClaw 失败 silent（按现有 messaging 语义、不阻 CLI）
 */
export function notifyRunningDaemons(deps: { fsFactory: (baseDir: string) => FileSystem }, source: string): void {
  const pm = createProcessManagerForCLI({ ...deps, motionClawId: MOTION_CLAW_ID });
  const chestnutRoot = getChestnutRoot();
  const rootFs = deps.fsFactory(chestnutRoot);
  const audit = createSystemAudit(rootFs, chestnutRoot);

  const candidates: string[] = [MOTION_CLAW_ID];
  const clawsDir = path.join(chestnutRoot, CLAWS_DIR);
  if (rootFs.existsSync(clawsDir)) {
    const subFs = deps.fsFactory(clawsDir);
    candidates.push(...enumerateClaws(subFs, '.'));
  }

  let notified = 0;
  for (const id of candidates) {
    const clawId = id === MOTION_CLAW_ID ? MOTION_CLAW_ID : makeClawId(id);
    if (!pm.isAlive(clawId)) continue;
    notifyClaw(rootFs, chestnutRoot, MOTION_CLAW_ID, id, {
      type: RELOAD_LLM_CONFIG_MESSAGE_TYPE,
      // source must not contain '/'; it goes into the inbox file name
      source: `cli-${source}`,
      priority: 'high',
      body: 'LLM config changed on disk; please reload.',
    }, audit);
    notified++;
  }

  if (notified > 0) {
    console.log(`✓ Notified ${notified} running daemon(s) to reload LLM config`);
  }
}

// Preset choices for interactive selection
const PRESET_CHOICES = Object.entries(PRESETS).map(([id, preset], index) => ({
  num: index + 1,
  id,
  displayName: preset.displayName,
  needsBaseUrl: !preset.defaultBaseUrl,
}));

// Helper to create readline interface
function createRL() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

// Promise wrapper for rl.question
function question(rl: readline.Interface, prompt: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const fullPrompt = defaultValue !== undefined
      ? `${prompt} [${defaultValue}]: `
      : `${prompt}: `;
    rl.question(fullPrompt, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

// Select preset interactively
async function selectPreset(rl: readline.Interface): Promise<string> {
  console.log('\nSelect preset:');
  // Display in two columns
  const half = Math.ceil(PRESET_CHOICES.length / 2);
  for (let i = 0; i < half; i++) {
    const left = PRESET_CHOICES[i];
    const right = PRESET_CHOICES[i + half];
    const leftStr = `${left.num}. ${left.id.padEnd(18)}`;
    const rightStr = right ? `${right.num}. ${right.id}` : '';
    console.log(`  ${leftStr}  ${rightStr}`);
  }
  
  const answer = await question(rl, '\n> ');
  const num = parseInt(answer, 10);
  if (isNaN(num)) { throw new CliError('Invalid choice: not a number'); }
  const choice = PRESET_CHOICES.find(c => c.num === num);
  if (!choice) {
    throw new CliError('Invalid selection');
  }
  return choice.id;
}

// Find provider by label in config
function findProviderIndex(config: ClawGlobalConfig, label: string): { type: 'primary' | 'fallback'; index: number } | null {
  if (config.llm.primary.label === label || config.llm.primary.preset === label) {
    return { type: 'primary', index: -1 };
  }
  const fbIndex = (config.llm.fallbacks ?? []).findIndex(
    f => f.label === label || f.preset === label
  );
  if (fbIndex !== -1) {
    return { type: 'fallback', index: fbIndex };
  }
  return null;
}

// provider add command
async function providerAdd(deps: { fsFactory: (baseDir: string) => FileSystem }): Promise<void> {
  const config = loadGlobalConfig(deps);
  const rl = createRL();
  
  try {
    // Select preset
    const presetId = await selectPreset(rl);
    const preset = PRESETS[presetId];
    
    // Label (optional)
    const defaultLabel = presetId;
    const labelInput = await question(rl, '\nLabel (optional, press Enter to use preset name)', defaultLabel);
    const label = labelInput || defaultLabel;
    
    // Check for duplicate label
    const existing = findProviderIndex(config, label);
    if (existing) {
      throw new CliError(`A provider with label "${label}" already exists`);
    }
    
    // API Key
    const apiKey = await question(rl, 'API Key (or ${ENV_VAR})');
    if (!apiKey) {
      throw new CliError('API Key is required');
    }
    
    // Base URL for custom presets
    let baseUrl: string | undefined;
    if (!preset.defaultBaseUrl) {
      baseUrl = await question(rl, 'Base URL');
      if (!baseUrl) {
        throw new CliError('Base URL is required for custom presets');
      }
    }
    
    // Model (with default from preset)
    const defaultModel = preset.defaultModel || 'unknown';
    const model = await question(rl, 'Model', defaultModel);
    
    // Role selection
    console.log('\nRole:');
    console.log('1. primary');
    console.log('2. fallback');
    const roleAnswer = await question(rl, '> ', '2');
    const role = roleAnswer === '1' ? 'primary' : 'fallback';
    
    // Build provider config
    const providerConfig: LLMProviderConfig = {
      preset: presetId,
      label,
      api_key: apiKey,
      model,

      temperature: 0.7,
      timeout_ms: DEFAULT_LLM_TIMEOUT_MS,
    };
    if (baseUrl) {
      providerConfig.base_url = baseUrl;
    }
    
    // Apply to config
    if (role === 'primary') {
      const currentPrimary = config.llm.primary;
      console.log(`\nCurrent primary (${currentPrimary.label || currentPrimary.preset}) will become fallback #1.`);
      const confirm = await question(rl, 'Confirm? [y/N]', 'N');
      if (confirm.toLowerCase() !== 'y') {
        console.log('Cancelled');
        rl.close();
        return;
      }
      
      // Move current primary to fallbacks[0]
      const newFallbacks = [currentPrimary, ...(config.llm.fallbacks ?? [])];
      config.llm.fallbacks = newFallbacks;
      config.llm.primary = providerConfig;
      console.log(`\n✓ Provider "${label}" is now primary`);
    } else {
      // Fallback role
      const currentFallbacks = config.llm.fallbacks ?? [];
      console.log(`\nCurrent fallbacks: ${currentFallbacks.length === 0 ? '(none)' : ''}`);
      currentFallbacks.forEach((f, i) => {
        console.log(`#${i + 1}: ${f.label || f.preset}`);
      });
      
      const posDefault = String(currentFallbacks.length + 1);
      const posStr = await question(rl, 'Position', posDefault);
      const position = parseInt(posStr, 10) - 1;
      if (Number.isNaN(position) || position < 0 || position > currentFallbacks.length) {
        throw new CliError(`Position must be 1-${currentFallbacks.length + 1}, got: ${posStr}`);
      }
      
      // Insert at position
      const newFallbacks = [...currentFallbacks];
      newFallbacks.splice(position, 0, providerConfig);
      config.llm.fallbacks = newFallbacks;
      console.log(`\n✓ Provider "${label}" added as fallback #${position + 1}`);
    }
    
    saveGlobalConfig(deps, config);
    notifyRunningDaemons(deps, 'add');

    // phase 451: 改 config 必 probe
    console.log('\nTesting connection...');
    const providerConfigRuntime = toProviderConfig(providerConfig);
    const probe = await checkLLMConnectionFor(providerConfigRuntime);
    if (probe.ok) {
      console.log(`✓ ${probe.model}`);
    } else {
      formatLLMError({
        errorType: probe.errorType,
        message: probe.message,
        provider: probe.provider,
        hint: LLM_ERROR_HINTS[probe.errorType],
      }).forEach(line => console.log(line));
      if (role === 'primary' && (probe.errorType === 'auth' || probe.errorType === 'model')) {
        // primary 失败 + actionable → 进 reconfigure
        const rlProbe = createRL();
        try {
          await promptReconfigure(deps, rlProbe, probe.errorType);
        } finally {
          rlProbe.close();
        }
      } else if (role === 'fallback') {
        // fallback 失败 → 警告、保留配置（用户可手动 remove）
        console.log('⚠ Fallback config saved but unreachable. Use "chestnut config provider remove" to clean up.');
      }
    }

  } finally {
    rl.close();
  }
}

function formatApiKey(apiKey: string): string {
  if (!apiKey) return '-';
  if (/^\$\{[A-Z_]+\}$/.test(apiKey)) return apiKey;
  if (apiKey.length <= 8) return apiKey.slice(0, 2) + '..' + apiKey.slice(-2);
  return apiKey.slice(0, 4) + '...' + apiKey.slice(-4);
}

// provider list command
async function providerList(deps: { fsFactory: (baseDir: string) => FileSystem }): Promise<void> {
  const config = loadGlobalConfig(deps);

  const primary = config.llm.primary;
  const fallbacks = config.llm.fallbacks ?? [];

  const terminalWidth = process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH;
  const fixedColWidth = 82; // "  PRIMARY   " + padEnd(10,15,18,24) + 4 spaces
  const urlWidth = Math.max(10, terminalWidth - fixedColWidth);

  // Header
  console.log();
  console.log(`  ${'ROLE'.padEnd(10)} ${'PRESET'.padEnd(10)} ${'LABEL'.padEnd(15)} ${'MODEL'.padEnd(18)} ${'API_KEY'.padEnd(24)} ${'BASE_URL'}`);

  // Primary
  const pPreset = primary.preset ?? '';
  const pLabel = primary.label || pPreset || '(unknown)';
  const pModel = primary.model || PRESETS[pPreset]?.defaultModel || 'unknown';
  const pBaseUrl = primary.base_url || PRESETS[pPreset]?.defaultBaseUrl || '-';
  const pApiKey = formatApiKey(primary.api_key ?? '');
  console.log(`  ${'PRIMARY'.padEnd(10)} ${pPreset.padEnd(10)} ${pLabel.padEnd(15)} ${pModel.padEnd(18)} ${pApiKey.padEnd(24)} ${fitLine(pBaseUrl, urlWidth)}`);

  // Fallbacks
  fallbacks.forEach((f, i) => {
    const fPreset = f.preset ?? '';
    const fLabel = f.label || fPreset || '(unknown)';
    const fModel = f.model || PRESETS[fPreset]?.defaultModel || 'unknown';
    const fBaseUrl = f.base_url || PRESETS[fPreset]?.defaultBaseUrl || '-';
    const fApiKey = formatApiKey(f.api_key ?? '');
    const rowLabel = `#${i + 1}`;
    console.log(`  ${rowLabel.padEnd(10)} ${fPreset.padEnd(10)} ${fLabel.padEnd(15)} ${fModel.padEnd(18)} ${fApiKey.padEnd(24)} ${fitLine(fBaseUrl, urlWidth)}`);
  });

  console.log();
}

// provider remove command
async function providerRemove(deps: { fsFactory: (baseDir: string) => FileSystem }, label: string): Promise<void> {
  const config = loadGlobalConfig(deps);
  
  const found = findProviderIndex(config, label);
  if (!found) {
    throw new CliError(`Provider "${label}" not found`);
  }
  
  if (found.type === 'primary') {
    throw new CliError('Cannot remove primary provider. Use "set-primary" to change it first.');
  }
  
  // Remove from fallbacks
  config.llm.fallbacks!.splice(found.index, 1);
  saveGlobalConfig(deps, config);
  console.log(`✓ Removed "${label}" from fallbacks`);
  notifyRunningDaemons(deps, 'remove');
}

// provider set-primary command
async function providerSetPrimary(deps: { fsFactory: (baseDir: string) => FileSystem }, label: string): Promise<void> {
  const config = loadGlobalConfig(deps);
  
  const found = findProviderIndex(config, label);
  if (!found) {
    throw new CliError(`Provider "${label}" not found`);
  }
  
  if (found.type === 'primary') {
    console.log(`"${label}" is already primary`);
    return;
  }
  
  const currentPrimary = config.llm.primary;
  const target = config.llm.fallbacks![found.index];
  
  console.log(`\nCurrent primary (${currentPrimary.label || currentPrimary.preset}) will become fallback #1.`);
  const rl = createRL();
  const confirm = await question(rl, 'Confirm? [y/N]', 'N');
  rl.close();
  
  if (confirm.toLowerCase() !== 'y') {
    console.log('Cancelled');
    return;
  }
  
  // Remove target from fallbacks
  config.llm.fallbacks!.splice(found.index, 1);
  
  // Move current primary to fallbacks[0]
  config.llm.fallbacks!.unshift(currentPrimary);
  
  // Set target as primary
  config.llm.primary = target;

  saveGlobalConfig(deps, config);
  console.log(`✓ "${label}" is now primary`);
  notifyRunningDaemons(deps, 'set-primary');

  // phase 451: 改 primary 必 probe
  console.log('\nTesting new primary connection...');
  const probe = await checkLLMConnection(deps);
  if (probe.ok) {
    console.log(`✓ ${probe.model}`);
  } else {
    formatLLMError({
      errorType: probe.errorType,
      message: probe.message,
      provider: probe.provider,
      hint: LLM_ERROR_HINTS[probe.errorType],
    }).forEach(line => console.log(line));
    if (probe.errorType === 'auth' || probe.errorType === 'model') {
      const rlProbe = createRL();
      try {
        await promptReconfigure(deps, rlProbe, probe.errorType);
      } finally {
        rlProbe.close();
      }
    }
  }
}

// provider move command
async function providerMove(deps: { fsFactory: (baseDir: string) => FileSystem }, label: string, position: string): Promise<void> {
  const config = loadGlobalConfig(deps);
  
  const found = findProviderIndex(config, label);
  if (!found) {
    throw new CliError(`Provider "${label}" not found`);
  }
  
  if (found.type === 'primary') {
    throw new CliError('Cannot move primary provider');
  }
  
  const newPos = parseInt(position, 10) - 1;
  const fallbacks = config.llm.fallbacks!;
  
  if (Number.isNaN(newPos) || newPos < 0 || newPos >= fallbacks.length) {
    throw new CliError(`Invalid position. Must be 1-${fallbacks.length}, got: ${position}`);
  }
  
  // Move element
  const [removed] = fallbacks.splice(found.index, 1);
  fallbacks.splice(newPos, 0, removed);
  
  saveGlobalConfig(deps, config);
  console.log(`✓ "${label}" moved to fallback #${newPos + 1}`);
  notifyRunningDaemons(deps, 'move');
}

// Build the config command
export function createConfigCommand(deps: { fsFactory: (baseDir: string) => FileSystem }): Command {
  const configCommand = new Command('config')
    .description('Manage chestnut configuration');

  // provider subcommand
  const providerCmd = new Command('provider')
    .description('Manage LLM providers');

  providerCmd
    .command('add')
    .description('Add a new provider interactively')
    .action(() => providerAdd(deps));

  providerCmd
    .command('list')
    .description('List all providers')
    .action(() => providerList(deps));

  providerCmd
    .command('remove <label>')
    .description('Remove a fallback provider')
    .action((label: string) => providerRemove(deps, label));

  providerCmd
    .command('set-primary <label>')
    .description('Set a provider as primary (current primary becomes fallback)')
    .action((label: string) => providerSetPrimary(deps, label));

  providerCmd
    .command('move <label> <position>')
    .description('Move a fallback provider to a new position (1-based)')
    .action((label: string, position: string) => providerMove(deps, label, position));

  configCommand.addCommand(providerCmd);
  return configCommand;
}
