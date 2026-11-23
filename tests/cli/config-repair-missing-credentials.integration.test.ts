import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { runChildProcess } from '../utils/child-process.js';
import { cleanupTempDirSync, createTrackedTempDirSync } from '../utils/temp.js';

const cliPath = path.resolve(__dirname, '../../dist/cli.js');
const CLI_CHILD_TIMEOUT_MS = 30_000;
const INTEGRATION_TEST_TIMEOUT_MS = 60_000;
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

    // Keep the PTY-less stdin open until the asynchronous probe/commit has settled.
    const repaired = await runChildProcess('/bin/bash', ['-c',
      `{ printf '3\\n'; sleep 2; printf 'repaired-model\\n'; sleep 3; } | ${process.execPath} ${cliPath} config provider repair main`,
    ], {
      cwd: path.dirname(cliPath), env: env(root, home, true), timeoutMs: CLI_CHILD_TIMEOUT_MS,
    });
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
});
