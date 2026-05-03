/**
 * init command - Initialize clawforum workspace
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { saveGlobalConfig, isInitialized, FORMAT_MAP, getWorkspaceRoot } from '../../foundation/config/index.js';
import { CliError } from '../errors.js';
import { PRESETS } from '../../foundation/llm-provider/presets.js';
import { DEFAULT_MAX_STEPS } from '../../constants.js';
import { LOGS_DIR } from '../../types/paths.js';

// Known providers shown in "Select provider" list (excludes generic custom-* entries)
const PROVIDER_LIST = [
  'anthropic',
  'openai',
  'deepseek',
  'moonshot',
  'minimax',
  'gemini',
  'ollama',
  'grok',
  'openrouter',
  'qwen-coder',
];

export async function initCommand(silent = false): Promise<void> {
  // Check if already initialized
  if (isInitialized()) {
    console.log('✓ Already initialized (.clawforum/config.yaml exists)');
    return;
  }

  console.log('Initializing clawforum...\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string, defaultValue?: string): Promise<string> => {
    return new Promise((resolve) => {
      const fullPrompt = defaultValue
        ? `${prompt} (default: ${defaultValue}): `
        : `${prompt}: `;
      rl.question(fullPrompt, (answer) => {
        resolve(answer.trim() || defaultValue || '');
      });
    });
  };

  // Read a password with echo suppressed; returns '' if cancelled ('b')
  const passwordQuestion = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      const fullPrompt = `${prompt} (b = back): `;
      let muted = false;
      const original = (rl as any)._writeToOutput?.bind(rl);
      (rl as any)._writeToOutput = (str: string) => {
        if (!muted) original?.(str);
      };
      rl.question(fullPrompt, (answer) => {
        muted = false;
        (rl as any)._writeToOutput = original;
        process.stdout.write('\n');
        resolve(answer.trim());
      });
      muted = true;
    });
  };

  try {
    let presetId = '';
    let apiKey = '';
    let model = '';
    let baseUrl: string | undefined;

    // Outer menu loop — lets option 2 / 3 return here via 'back'
    outer: while (true) {
      console.log('Configure LLM API:');
      console.log('  1. Scan environment variables');
      console.log('  2. Enter API key manually');
      console.log('  3. Select provider');
      const configMethod = await question('\n> ', '1');

      if (configMethod === '1') {
        // ── Branch 1: scan env vars ──
        const detected = Object.values(PRESETS)
          .map(p => p.envVar)
          .filter((v): v is string => !!v && !!process.env[v])
          .filter((v, i, arr) => arr.indexOf(v) === i);

        if (detected.length > 0) {
          console.log('\nDetected:');
          detected.forEach((v, i) => console.log(`  ${i + 1}. ${v}`));
          const pick = await question('\n> (number or variable name)');
          const idx = parseInt(pick, 10) - 1;
          let varName: string;
          if (pick.trim() && idx >= 0 && idx < detected.length) {
            varName = detected[idx];
          } else if (/^[A-Z][A-Z0-9_]*$/.test(pick.trim())) {
            varName = pick.trim();
          } else {
            throw new CliError('Invalid input. Enter a number or a variable name (e.g. MY_API_KEY).');
          }

          if (!process.env[varName]) { throw new CliError(`Environment variable ${varName} is not set`); }
          apiKey = '${' + varName + '}';
          console.log(`✓ Will read from ${varName} at runtime`);

          const matchedEntry = Object.entries(PRESETS).find(([, p]) => p.envVar === varName);
          if (matchedEntry) {
            [presetId] = matchedEntry;
            model = await question(`Model (auto = ${matchedEntry[1].defaultModel ?? 'preset default'})`, 'auto');
          } else {
            console.log('\nCould not determine provider. Select API format:');
            console.log('  1. Anthropic');
            console.log('  2. OpenAI');
            console.log('  3. Gemini');
            const fmt = await question('\n> ', '2');
            presetId = FORMAT_MAP[fmt] ?? 'custom-openai';
            baseUrl = await question('Base URL');
            if (!baseUrl) { throw new CliError('Base URL is required'); }
            model = await question('Model');
            if (!model) { throw new CliError('Model is required'); }
          }

        } else {
          console.log('\n  No API key environment variables detected.');
          const varName = await question('Enter environment variable name (e.g. MY_API_KEY)');
          if (!varName) { throw new CliError('Variable name is required'); }

          if (!process.env[varName]) { throw new CliError(`Environment variable ${varName} is not set`); }
          apiKey = '${' + varName + '}';
          console.log(`✓ Will read from ${varName} at runtime`);

          console.log('\nSelect API format:');
          console.log('  1. Anthropic');
          console.log('  2. OpenAI');
          console.log('  3. Gemini');
          const fmt = await question('\n> ', '2');
          presetId = FORMAT_MAP[fmt] ?? 'custom-openai';
          baseUrl = await question('Base URL');
          if (!baseUrl) { throw new CliError('Base URL is required'); }
          model = await question('Model');
          if (!model) { throw new CliError('Model is required'); }
        }

        break outer;

      } else if (configMethod === '2') {
        // ── Branch 2: manual (step machine with back navigation) ──
        // Steps: format → baseUrl → apiKey → model
        // 'b' goes back one step; 'b' at format returns to outer menu

        type ManualStep = 'format' | 'baseUrl' | 'apiKey' | 'model' | 'done';
        let step: ManualStep = 'format';

        let manualFormat = '';
        let manualBaseUrl = '';
        let manualApiKey = '';
        let manualModel = '';

        while (step !== 'done') {
          if (step === 'format') {
            console.log('\nAPI Format (b = back to menu):');
            console.log('  1. Anthropic');
            console.log('  2. OpenAI');
            console.log('  3. Gemini');
            const fmt = await question('\n> ');
            if (fmt === 'b') { console.log(); continue outer; }
            manualFormat = FORMAT_MAP[fmt] ?? '';
            if (!manualFormat) { console.log('Invalid choice.'); continue; }
            step = 'baseUrl';

          } else if (step === 'baseUrl') {
            const raw = await question('Base URL (b = back)');
            if (raw === 'b') { step = 'format'; continue; }
            if (!raw) { console.log('Base URL is required.'); continue; }
            manualBaseUrl = raw;
            step = 'apiKey';

          } else if (step === 'apiKey') {
            const raw = await passwordQuestion('API Key');
            if (raw === 'b') { step = 'baseUrl'; continue; }
            if (!raw) { console.log('API Key is required.'); continue; }
            manualApiKey = raw;
            step = 'model';

          } else if (step === 'model') {
            const raw = await question('Model (b = back)');
            if (raw === 'b') { step = 'apiKey'; continue; }
            if (!raw) { console.log('Model is required.'); continue; }
            manualModel = raw;
            step = 'done';
          }
        }

        presetId = manualFormat;
        baseUrl = manualBaseUrl;
        apiKey = manualApiKey;
        model = manualModel;
        break outer;

      } else if (configMethod === '3') {
        // ── Branch 3: select provider from preset list ──
        // Steps: provider → apiKey → model
        // 'b' goes back one step; 'b' at provider list returns to outer menu

        const providers = PROVIDER_LIST
          .map(id => PRESETS[id])
          .filter(Boolean);

        type ProviderStep = 'pick' | 'apiKey' | 'model' | 'done';
        let step: ProviderStep = 'pick';

        let pickedPresetId = '';
        let pickedApiKey = '';
        let pickedModel = '';

        while (step !== 'done') {
          if (step === 'pick') {
            console.log('\nSelect provider (b = back to menu):');
            providers.forEach((p, i) =>
              console.log(`  ${i + 1}. ${p.displayName}  (${p.defaultModel ?? 'custom model'})`)
            );
            const raw = await question('\n> ');
            if (raw === 'b') { console.log(); continue outer; }
            const idx = parseInt(raw, 10) - 1;
            if (isNaN(idx) || idx < 0 || idx >= providers.length) {
              console.log('Invalid choice.');
              continue;
            }
            const preset = providers[idx];
            pickedPresetId = preset.id;
            step = 'apiKey';

          } else if (step === 'apiKey') {
            const preset = PRESETS[pickedPresetId];
            // Suggest env var if available and set
            const envHint = preset.envVar && process.env[preset.envVar]
              ? ` (or press Enter to use ${preset.envVar})`
              : '';
            const raw = await passwordQuestion(`API Key${envHint}`);
            if (raw === 'b') { step = 'pick'; continue; }
            if (!raw && preset.envVar && process.env[preset.envVar]) {
              pickedApiKey = '${' + preset.envVar + '}';
              console.log(`✓ Will read from ${preset.envVar} at runtime`);
            } else if (!raw) {
              console.log('API Key is required.');
              continue;
            } else {
              pickedApiKey = raw;
            }
            step = 'model';

          } else if (step === 'model') {
            const preset = PRESETS[pickedPresetId];
            const raw = await question(`Model (b = back, auto = ${preset.defaultModel ?? 'preset default'})`, 'auto');
            if (raw === 'b') { step = 'apiKey'; continue; }
            pickedModel = raw;
            step = 'done';
          }
        }

        presetId = pickedPresetId;
        apiKey = pickedApiKey;
        model = pickedModel;
        // baseUrl comes from preset; no manual entry needed (already in preset.defaultBaseUrl)
        break outer;

      } else {
        console.log('Invalid selection.\n');
        // loop back to menu
      }
    }

    // Build config
    const config = {
      version: '1',
      llm: {
        primary: {
          preset: presetId,
          api_key: apiKey,
          model: model,
          max_tokens: 4096,
          temperature: 0.7,
          timeout_ms: 60000,
          ...(baseUrl && { base_url: baseUrl }),
        },
        retry_attempts: 3,
        retry_delay_ms: 1000,
      },
      tool_timeout_ms: 60000,
      watchdog: {
        interval_ms: 30000,
        disk_warning_mb: 500,
        log_archive_days: 30,
        claw_inactivity_timeout_ms: 300000,
      },
      motion: {
        heartbeat_interval_ms: 0,
        max_steps: DEFAULT_MAX_STEPS,
        max_concurrent_tasks: 3,
        llm_idle_timeout_ms: 120000,
      },
    };

    // Save config
    saveGlobalConfig(config);

    // Create logs directory
    const logsDir = path.join(getWorkspaceRoot(), '.clawforum', LOGS_DIR);
    fs.mkdirSync(logsDir, { recursive: true });

    console.log('\n✓ Initialized successfully!');
    if (!silent) {
      console.log('\nNext steps:');
      console.log('  1. Create a Claw: clawforum claw create <name>');
      console.log('  2. Start chatting: clawforum claw chat <name>');
    }

  } catch (error) {
    throw new CliError(`Init failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rl.close();
  }
}
