import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  createConfigRepairWorkspace,
  finishConfigRepairCase,
  readConfigRepairRaw,
  runConfigRepairSession,
  startConfigRepairServer,
  type ConfigRepairServer,
  type ConfigRepairWorkspace,
  type InteractiveAnswer,
} from '../helpers/config-repair-session.js';

const PRECOMMIT_TEST_TIMEOUT_MS = 60_000;
let server: ConfigRepairServer;

beforeAll(async () => {
  server = await startConfigRepairServer();
});

beforeEach(() => {
  server.requests.length = 0;
  server.setBehavior('sse');
});

afterAll(async () => {
  await server.close();
});

function configPath(workspace: ConfigRepairWorkspace): string {
  return path.join(workspace.root, '.chestnut', 'llm', 'config.yaml');
}

function writeDocument(workspace: ConfigRepairWorkspace, document: unknown): void {
  fs.writeFileSync(configPath(workspace), yaml.dump(document));
}

function credentialText(workspace: ConfigRepairWorkspace): string {
  const file = path.join(workspace.root, '.chestnut', 'llm', 'credentials.yaml');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function credentialRefs(workspace: ConfigRepairWorkspace): string[] {
  const text = credentialText(workspace);
  if (!text) return [];
  const document = yaml.load(text) as { refs?: Record<string, unknown> };
  return Object.keys(document.refs ?? {}).sort();
}

async function runRepair(
  workspace: ConfigRepairWorkspace,
  label: string,
  answers: InteractiveAnswer[],
  signal: AbortSignal,
  withKey = false,
) {
  return runConfigRepairSession(
    workspace, ['config', 'provider', 'repair', label], answers, signal, withKey,
  );
}

describe('real CLI repair precommit failures', () => {
  it('missing primary ref followed by retry and cancel preserves raw and performs no HTTP request', async context => {
    const workspace = createConfigRepairWorkspace(server.baseUrl);
    await finishConfigRepairCase(workspace, async () => {
      const before = readConfigRepairRaw(workspace.root);
      const beforeCredentials = credentialRefs(workspace);
      const outcome = await runRepair(workspace, 'main', [
        { prompt: /> : $/, value: '1' },
        { prompt: /> : $/, value: 'n' },
      ], context.signal);

      expect(outcome.execution.kind).toBe('gone');
      expect(readConfigRepairRaw(workspace.root)).toEqual(before);
      expect(credentialRefs(workspace)).toEqual(beforeCredentials);
      expect(server.requests).toHaveLength(0);
    });
  }, PRECOMMIT_TEST_TIMEOUT_MS);

  it('fallback HTTP rejection does not commit and discards only the new credential', async context => {
    const workspace = createConfigRepairWorkspace(server.baseUrl);
    const initial = readConfigRepairRaw(workspace.root);
    writeDocument(workspace, {
      ...initial.document,
      fallbacks: [{
        ...initial.document.primary,
        api_key: '${PHASE2226_FALLBACK_KEY}',
        model: 'fallback-model',
        label: 'fallback',
      }],
    });
    server.setBehavior('reject');
    await finishConfigRepairCase(workspace, async () => {
      const before = readConfigRepairRaw(workspace.root);
      const beforeCredentials = credentialRefs(workspace);
      const outcome = await runRepair(workspace, 'fallback', [
        { prompt: /> : $/, value: '2' },
        { prompt: /New API key \(b = back\): $/, value: 'fallback-temporary-secret' },
        { prompt: /> : $/, value: 'n' },
      ], context.signal);

      expect(outcome.execution.kind).toBe('gone');
      expect(readConfigRepairRaw(workspace.root)).toEqual(before);
      expect(credentialRefs(workspace)).toEqual(beforeCredentials);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.model).toBe('fallback-model');
      expect(server.requests[0]?.headers.authorization).toBe('Bearer fallback-temporary-secret');
      expect(`${outcome.stdout}\n${outcome.stderr}\n${credentialText(workspace)}`)
        .not.toContain('fallback-temporary-secret');
    });
  }, PRECOMMIT_TEST_TIMEOUT_MS);

  it('missing header ref cannot be misreported as another slot repair', async context => {
    const workspace = createConfigRepairWorkspace(server.baseUrl);
    const initial = readConfigRepairRaw(workspace.root);
    writeDocument(workspace, {
      ...initial.document,
      primary: {
        ...initial.document.primary,
        extra_headers: { 'X-Repair-Test': '${PHASE2226_MISSING_HEADER}' },
      },
    });
    await finishConfigRepairCase(workspace, async () => {
      const before = readConfigRepairRaw(workspace.root);
      const outcome = await runRepair(workspace, 'main', [
        { prompt: /> : $/, value: '1' },
        { prompt: /> : $/, value: 'n' },
      ], context.signal, true);

      expect(outcome.execution.kind).toBe('gone');
      expect(readConfigRepairRaw(workspace.root)).toEqual(before);
      expect(server.requests).toHaveLength(0);
      expect(outcome.stdout).toContain('PHASE2226_MISSING_HEADER');
    });
  }, PRECOMMIT_TEST_TIMEOUT_MS);

  it('provider timeout does not advance revision and cleans the unreferenced new key', async context => {
    const workspace = createConfigRepairWorkspace(server.baseUrl, 1_000);
    server.setBehavior('hang');
    await finishConfigRepairCase(workspace, async () => {
      const before = readConfigRepairRaw(workspace.root);
      const beforeCredentials = credentialRefs(workspace);
      const outcome = await runRepair(workspace, 'main', [
        { prompt: /> : $/, value: '2' },
        { prompt: /New API key \(b = back\): $/, value: 'timeout-temporary-secret' },
        { prompt: /> : $/, value: 'n' },
      ], context.signal);

      expect(outcome.execution.kind).toBe('gone');
      expect(readConfigRepairRaw(workspace.root)).toEqual(before);
      expect(credentialRefs(workspace)).toEqual(beforeCredentials);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.model).toBe('original-model');
      expect(`${outcome.stdout}\n${outcome.stderr}\n${credentialText(workspace)}`)
        .not.toContain('timeout-temporary-secret');
    });
  }, PRECOMMIT_TEST_TIMEOUT_MS);
});
