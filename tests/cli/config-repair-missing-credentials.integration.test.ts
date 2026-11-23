import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { spawn } from 'node:child_process';
import { runChildProcess } from '../utils/child-process.js';
import { cleanupTempDirSync, createTrackedTempDirSync } from '../utils/temp.js';

const cliPath = path.resolve(__dirname, '../../dist/cli.js');
const CLI_CHILD_TIMEOUT_MS = 30_000;
const INTEGRATION_TEST_TIMEOUT_MS = 60_000;
const PTY_RESPONSE_DELAY_MS = 500;
const REF = 'PHASE2221_INTEGRATION_KEY';
let server: http.Server;
let baseUrl: string;
let requests = 0;
const tempDirs: string[] = [];

beforeAll(async () => {
  server = http.createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const frames = [
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('integration server has no port');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

afterEach(() => {
  while (tempDirs.length > 0) cleanupTempDirSync(tempDirs.pop()!);
});

function workspace(): string {
  const dir = createTrackedTempDirSync('chestnut-config-repair-integration-');
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.chestnut', 'llm'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.chestnut', 'claws'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.chestnut', 'config.yaml'), "version: '1'\n");
  fs.writeFileSync(path.join(dir, '.chestnut', 'llm', 'config.yaml'), `schema_version: 1
revision: 1
primary:
  provider_id: custom:openai
  api_format: openai
  auth_profile: api_key
  api_key: \${${REF}}
  model: original-model
  label: main
  base_url: ${baseUrl}
`);
  return dir;
}

function env(root: string, home: string, withKey: boolean): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    CHESTNUT_ROOT: root,
    CHESTNUT_HOME: home,
    NODE_NO_WARNINGS: '1',
  };
  delete env[REF];
  if (withKey) env[REF] = 'integration-secret';
  return env;
}

async function runCli(root: string, home: string, args: string[], input = '', withKey = false) {
  return runChildProcess(process.execPath, [cliPath, ...args], {
    cwd: path.dirname(cliPath),
    env: env(root, home, withKey),
    input,
    timeoutMs: CLI_CHILD_TIMEOUT_MS,
  });
}

interface InteractiveAnswer {
  readonly prompt: RegExp;
  readonly value: string;
}

/** Drive the real CLI through a PTY and answer only after each actual prompt. */
async function runInteractiveCli(
  root: string,
  home: string,
  args: string[],
  answers: InteractiveAnswer[],
  withKey = false,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const command = [process.execPath, cliPath, ...args];
  const child = process.platform === 'darwin'
    ? spawn('script', ['-q', '/dev/null', ...command], {
      cwd: path.dirname(cliPath), env: env(root, home, withKey), stdio: 'pipe', detached: true,
    })
    : spawn('script', ['-qec', command.join(' '), '/dev/null'], {
      cwd: path.dirname(cliPath), env: env(root, home, withKey), stdio: 'pipe', detached: true,
    });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let answerIndex = 0;
    let lastPrompt = '';
    let responseTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const terminate = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      terminate();
      const error = new Error(`interactive CLI timed out at answer ${answerIndex}/${answers.length}: ${stdout}\n${stderr}`);
      reject(error);
      settled = true;
    }, CLI_CHILD_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const plainTail = stdout.slice(-1_000).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
      if (answerIndex >= answers.length || plainTail === lastPrompt
        || !answers[answerIndex].prompt.test(plainTail)) return;
      lastPrompt = plainTail;
      responseTimer = setTimeout(() => {
        if (!settled && answerIndex < answers.length) {
          child.stdin.write(`${answers[answerIndex++].value}\n`);
        }
      }, PTY_RESPONSE_DELAY_MS);
    });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (responseTimer) clearTimeout(responseTimer);
      reject(error);
    });
    child.on('close', status => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (responseTimer) clearTimeout(responseTimer);
      if (answerIndex < answers.length) {
        reject(new Error(`interactive CLI exited after ${answerIndex}/${answers.length} answers: ${stdout}\n${stderr}`));
        return;
      }
      resolve({ status, stdout, stderr });
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runInteractiveCliWithDelays(
  root: string,
  home: string,
  args: string[],
  answers: string[],
) {
  const command = [process.execPath, cliPath, ...args].map(shellQuote).join(' ');
  const ptyCommand = process.platform === 'darwin'
    ? `script -q /dev/null ${command}`
    : `script -qec ${shellQuote(command)} /dev/null`;
  const writes = answers.map(answer => `printf ${shellQuote(`${answer}\n`)}; sleep 2;`).join(' ');
  return runChildProcess('/bin/bash', ['-c', `{ ${writes} sleep 3; } | ${ptyCommand}`], {
    cwd: path.dirname(cliPath), env: env(root, home, false), timeoutMs: CLI_CHILD_TIMEOUT_MS,
  });
}

function readRaw(root: string) {
  const configPath = path.join(root, '.chestnut', 'llm', 'config.yaml');
  return {
    text: fs.readFileSync(configPath, 'utf8'),
    document: yaml.load(fs.readFileSync(configPath, 'utf8')) as {
      revision: number;
      primary: Record<string, unknown>;
      fallbacks?: Array<Record<string, unknown>>;
    },
  };
}

describe('real CLI missing-credential repair chain', () => {
  it('start fails before supervision, real Commander repair preserves the slot, and full raw/resolved reads recover', async () => {
    const root = workspace();
    const home = createTrackedTempDirSync('chestnut-config-repair-home-');
    tempDirs.push(home);
    requests = 0;

    const failedStart = await runCli(root, home, ['start', '--non-interactive']);
    expect(failedStart.status).toBe(3);
    expect(failedStart.stderr).toContain(REF);
    expect(failedStart.stderr).toContain('config provider repair');
    expect(failedStart.stderr).not.toContain('corrupted');
    expect(failedStart.stderr).not.toContain('integration-secret');
    expect(requests).toBe(0);
    expect(fs.existsSync(path.join(root, '.chestnut', 'motion', 'daemon'))).toBe(false);

    const repaired = await runInteractiveCli(root, home, ['config', 'provider', 'repair', 'main'], [
      { prompt: /> : $/, value: '3' },
      { prompt: /New model \(b = back\): $/, value: 'repaired-model' },
    ], true);
    expect(repaired.status).toBe(0);
    expect(repaired.stdout).toContain('repaired in place at revision 2');
    expect(repaired.stderr).not.toContain('integration-secret');
    expect(requests).toBeGreaterThan(0);

    const configPath = path.join(root, '.chestnut', 'llm', 'config.yaml');
    const rawText = fs.readFileSync(configPath, 'utf8');
    const raw = yaml.load(rawText) as {
      revision: number;
      primary: { model: string; label: string; api_key: string };
      fallbacks?: unknown[];
    };
    expect(raw.revision).toBe(2);
    expect(raw.primary).toMatchObject({
      model: 'repaired-model', label: 'main', api_key: `\${${REF}}`,
    });
    expect(raw.fallbacks).toBeUndefined();
    expect(rawText).not.toContain('integration-secret');

    const status = await runCli(root, home, ['status'], '', true);
    if (status.status !== 0) throw new Error(`status failed: ${status.stderr}`);
    expect(status.status).toBe(0);
    expect(status.stderr).not.toContain('credential unavailable');
    expect(status.stderr).not.toContain('integration-secret');
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('缺 key → repair key 写独立 ref，且单字段提交不物化 defaults', async () => {
    const root = workspace();
    const home = createTrackedTempDirSync('chestnut-config-repair-home-');
    tempDirs.push(home);

    const repaired = await runInteractiveCli(root, home, ['config', 'provider', 'repair', 'main'], [
      { prompt: /> : $/, value: '2' },
      { prompt: /New API key \(b = back\): $/, value: 'new-cli-secret' },
    ]);
    if (repaired.status !== 0) throw new Error(`repair key failed: ${repaired.stderr}\n${repaired.stdout}`);
    expect(repaired.stdout).toContain('repaired in place at revision 2');
    expect(repaired.stdout).not.toContain('new-cli-secret');
    expect(repaired.stderr).not.toContain('new-cli-secret');

    const raw = readRaw(root);
    expect(raw.document.revision).toBe(2);
    expect(raw.document.primary).toMatchObject({ label: 'main', model: 'original-model' });
    expect(raw.document.primary.api_key).not.toBe(`\${${REF}}`);
    expect(raw.document.primary).not.toHaveProperty('temperature');
    expect(raw.document.primary).not.toHaveProperty('timeout_ms');
    expect(raw.document.fallbacks).toBeUndefined();
    expect(raw.text).not.toContain('new-cli-secret');

    const status = await runCli(root, home, ['status']);
    if (status.status !== 0) throw new Error(`status after key repair failed: ${status.stderr}`);
    expect(status.status).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('add 新 primary → 旧坏条目成为 fallback → remove 后完整配置恢复', async () => {
    const root = workspace();
    const home = createTrackedTempDirSync('chestnut-config-repair-home-');
    tempDirs.push(home);

    const added = await runInteractiveCliWithDelays(root, home, ['config', 'provider', 'add'], [
      '10', '2', baseUrl, 'added-secret', 'added-model', 'y', 'added', '1', 'y',
    ]);
    if (added.status !== 0) throw new Error(`provider add failed: ${added.stderr}\n${added.stdout}`);
    expect(added.stdout).toContain('Provider "added" is now primary');
    expect(`${added.stdout}\n${added.stderr}`).toContain('not ready');
    const afterAdd = readRaw(root);
    expect(afterAdd.document.revision).toBe(2);
    expect(afterAdd.document.primary).toMatchObject({ label: 'added', model: 'added-model' });
    expect(afterAdd.document.fallbacks).toHaveLength(1);
    expect(afterAdd.document.fallbacks?.[0]).toMatchObject({ label: 'main', api_key: `\${${REF}}` });

    const removed = await runCli(root, home, ['config', 'provider', 'remove', 'main']);
    if (removed.status !== 0) throw new Error(`remove broken fallback failed: ${removed.stderr}`);
    expect(removed.stdout).toContain('Removed provider');
    const afterRemove = readRaw(root);
    expect(afterRemove.document.revision).toBe(3);
    expect(afterRemove.document.primary).toMatchObject({ label: 'added', model: 'added-model' });
    expect(afterRemove.document.fallbacks ?? []).toHaveLength(0);

    const status = await runCli(root, home, ['status']);
    if (status.status !== 0) throw new Error(`status after add/remove failed: ${status.stderr}`);
    expect(status.status).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
