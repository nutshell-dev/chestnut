/**
 * config command - Manage LLM provider configuration
 */

import * as readline from 'readline';
import { Command } from 'commander';
import {
  loadGlobalConfig,
  saveGlobalConfig,
  getMotionDir,
  type ClawGlobalConfig,
  LLMProviderSchema,
} from '../../foundation/config/index.js';
import { PRESETS } from '../../foundation/llm-provider/index.js';
import { createProcessManagerForCLI } from '../utils/factories.js';
import { z } from 'zod';
import { CliError } from '../errors.js';
import { REACT_DEFAULT_MAX_TOKENS } from '../../core/agent-executor/constants.js';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../foundation/llm-orchestrator/defaults.js';

/**
 * If motion daemon is running, ask user whether to restart it so config changes take effect.
 * Killing the daemon is enough — watchdog will respawn it automatically.
 */
async function promptRestartDaemon(rl?: readline.Interface): Promise<void> {
  const pm = createProcessManagerForCLI();
  if (!pm.isAlive('motion')) return;

  const needClose = !rl;
  if (!rl) rl = createRL();
  try {
    const answer = await question(rl, '\nMotion daemon is running. Restart to apply changes? [y/N]', 'N');
    if (answer.toLowerCase() === 'y') {
      const stopped = await pm.stop('motion');
      if (stopped) {
        console.log('✓ Daemon stopped. Watchdog will restart it automatically.');
      } else {
        console.log('Failed to stop daemon. You can restart manually: clawforum stop && clawforum motion chat');
      }
    }
  } finally {
    if (needClose) rl.close();
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
async function providerAdd(): Promise<void> {
  const config = loadGlobalConfig();
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
    
    // Max tokens
    const maxTokensStr = await question(rl, 'Max tokens', '4096');
    const max_tokens = parseInt(maxTokensStr, 10) || REACT_DEFAULT_MAX_TOKENS;
    
    // Role selection
    console.log('\nRole:');
    console.log('  1. primary');
    console.log('  2. fallback');
    const roleAnswer = await question(rl, '> ', '2');
    const role = roleAnswer === '1' ? 'primary' : 'fallback';
    
    // Build provider config
    const providerConfig: z.infer<typeof LLMProviderSchema> = {
      preset: presetId,
      label,
      api_key: apiKey,
      model,
      max_tokens,
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
        console.log(`  #${i + 1}: ${f.label || f.preset}`);
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
    
    saveGlobalConfig(config);
    await promptRestartDaemon(rl);

  } finally {
    rl.close();
  }
}

// provider list command
async function providerList(): Promise<void> {
  const config = loadGlobalConfig();
  
  const primary = config.llm.primary;
  const fallbacks = config.llm.fallbacks ?? [];
  
  // Header
  console.log();
  
  // Primary
  const pPreset = primary.preset ?? '';
  const pLabel = primary.label || pPreset || '(unknown)';
  const pModel = primary.model || PRESETS[pPreset]?.defaultModel || 'unknown';
  const pBaseUrl = primary.base_url || PRESETS[pPreset]?.defaultBaseUrl || '-';
  console.log(`  PRIMARY   ${pPreset.padEnd(10)} ${pLabel.padEnd(15)} ${pModel.padEnd(18)} ${pBaseUrl.slice(0, 30)}`);

  // Fallbacks
  fallbacks.forEach((f, i) => {
    const fPreset = f.preset ?? '';
    const fLabel = f.label || fPreset || '(unknown)';
    const fModel = f.model || PRESETS[fPreset]?.defaultModel || 'unknown';
    const fBaseUrl = f.base_url || PRESETS[fPreset]?.defaultBaseUrl || '-';
    console.log(`  #${i + 1}       ${fPreset.padEnd(10)} ${fLabel.padEnd(15)} ${fModel.padEnd(18)} ${fBaseUrl.slice(0, 30)}`);
  });
  
  console.log();
}

// provider remove command
async function providerRemove(label: string): Promise<void> {
  const config = loadGlobalConfig();
  
  const found = findProviderIndex(config, label);
  if (!found) {
    throw new CliError(`Provider "${label}" not found`);
  }
  
  if (found.type === 'primary') {
    throw new CliError('Cannot remove primary provider. Use "set-primary" to change it first.');
  }
  
  // Remove from fallbacks
  config.llm.fallbacks!.splice(found.index, 1);
  saveGlobalConfig(config);
  console.log(`✓ Removed "${label}" from fallbacks`);
  await promptRestartDaemon();
}

// provider set-primary command
async function providerSetPrimary(label: string): Promise<void> {
  const config = loadGlobalConfig();
  
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

  saveGlobalConfig(config);
  console.log(`✓ "${label}" is now primary`);
  await promptRestartDaemon();
}

// provider move command
async function providerMove(label: string, position: string): Promise<void> {
  const config = loadGlobalConfig();
  
  const found = findProviderIndex(config, label);
  if (!found) {
    throw new CliError(`Provider "${label}" not found`);
  }
  
  if (found.type === 'primary') {
    throw new CliError('Cannot move primary provider');
  }
  
  const newPos = parseInt(position, 10) - 1;
  const fallbacks = config.llm.fallbacks!;
  
  if (newPos < 0 || newPos >= fallbacks.length) {
    throw new CliError(`Invalid position. Must be 1-${fallbacks.length}`);
  }
  
  // Move element
  const [removed] = fallbacks.splice(found.index, 1);
  fallbacks.splice(newPos, 0, removed);
  
  saveGlobalConfig(config);
  console.log(`✓ "${label}" moved to fallback #${newPos + 1}`);
  await promptRestartDaemon();
}

// Build the config command
export const configCommand = new Command('config')
  .description('Manage clawforum configuration');

// provider subcommand
const providerCmd = new Command('provider')
  .description('Manage LLM providers');

providerCmd
  .command('add')
  .description('Add a new provider interactively')
  .action(providerAdd);

providerCmd
  .command('list')
  .description('List all providers')
  .action(providerList);

providerCmd
  .command('remove <label>')
  .description('Remove a fallback provider')
  .action(providerRemove);

providerCmd
  .command('set-primary <label>')
  .description('Set a provider as primary (current primary becomes fallback)')
  .action(providerSetPrimary);

providerCmd
  .command('move <label> <position>')
  .description('Move a fallback provider to a new position (1-based)')
  .action(providerMove);

configCommand.addCommand(providerCmd);
