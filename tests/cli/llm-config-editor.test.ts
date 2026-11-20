import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as readline from 'node:readline';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { collectExplicitLLMConfig } from '../../src/cli/llm-config-editor.js';

let root: string;
let originalIsTTY: boolean | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2207-editor-'));
  originalIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  fs.rmSync(root, { recursive: true, force: true });
});

async function runEditor(answers: string[], name: string) {
  vi.stubEnv('CHESTNUT_ROOT', path.join(root, name));
  const queue = [...answers];
  const prompts: string[] = [];
  const output: string[] = [];
  const next = () => queue.shift() ?? '';
  const rl = {
    question: vi.fn((prompt: string, callback: (answer: string) => void) => {
      prompts.push(prompt);
      callback(next());
    }),
    _writeToOutput: vi.fn(),
  } as unknown as readline.Interface;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  });
  const question = async (prompt: string, defaultValue?: string) => {
    const rendered = `${prompt}${defaultValue ? ` [${defaultValue}]` : ''}: `;
    prompts.push(rendered);
    return next() || defaultValue || '';
  };
  const created: { ref: string; value: string }[] = [];
  const result = await collectExplicitLLMConfig(
    { fsFactory: baseDir => new NodeFileSystem({ baseDir }) },
    rl,
    question,
    created,
  );
  return { result, prompts, output };
}

describe('shared explicit LLM configuration editor', () => {
  it('同一 fixed 输入脚本产生完全相同的字段、提示、输出和 explicit draft', async () => {
    const first = await runEditor(['7', 'sk-ant-secret', ''], 'start');
    const second = await runEditor(['7', 'sk-ant-secret', ''], 'provider-add');
    expect(second.prompts).toEqual(first.prompts);
    expect(second.output).toEqual(first.output);
    expect(second.result).toEqual(first.result);
    expect(first.result).toMatchObject({
      kind: 'collected',
      draft: {
        providerId: 'anthropic', apiFormat: 'anthropic', authProfile: 'api_key',
        apiKey: '${ANTHROPIC_API_KEY}', model: 'claude-3-7-sonnet-20250219',
      },
    });
    expect(JSON.stringify(first.result)).not.toContain('sk-ant-secret');
    expect(first.result).not.toHaveProperty('presetId');
  });

  it('同一 custom 输入脚本共享 protocol/base URL/key/model/preview/confirm', async () => {
    const answers = ['10', '2', 'https://example.test/v1', 'sk-custom-secret', 'custom-model', 'y'];
    const first = await runEditor(answers, 'start');
    const second = await runEditor(answers, 'provider-add');
    expect(second.prompts).toEqual(first.prompts);
    expect(second.output).toEqual(first.output);
    expect(second.result).toEqual(first.result);
    expect(first.output.join('\n')).toContain('Configuration preview');
    expect(first.output.join('\n')).toContain('Base URL: https://example.test/v1');
    expect(first.output.join('\n')).not.toContain('sk-custom-secret');
    expect(first.result).toMatchObject({
      kind: 'collected',
      draft: {
        providerId: 'custom:openai', apiFormat: 'openai', model: 'custom-model',
        baseUrl: 'https://example.test/v1',
      },
    });
  });

  it('custom 确认取消在两个调用方呈现同一结果且不含 commit target', async () => {
    const answers = ['10', '2', 'https://example.test/v1', 'sk-custom-secret', 'custom-model', 'n'];
    const first = await runEditor(answers, 'start');
    const second = await runEditor(answers, 'provider-add');
    expect(first.result).toEqual({ kind: 'cancelled', reason: 'user_cancelled' });
    expect(second.result).toEqual(first.result);
    expect(second.prompts).toEqual(first.prompts);
    expect(second.output).toEqual(first.output);
  });
});
