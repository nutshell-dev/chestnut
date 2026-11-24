import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  CONFIG_REPAIR_REF,
  createConfigRepairWorkspace,
  finishConfigRepairCase,
  readConfigRepairRaw,
  runConfigRepairCli,
  runConfigRepairSession,
  startConfigRepairServer,
  type ConfigRepairServer,
  type ConfigRepairWorkspace,
  type InteractiveAnswer,
} from '../helpers/config-repair-session.js';

const INTEGRATION_TEST_TIMEOUT_MS = 60_000;
let server: ConfigRepairServer;

beforeAll(async () => {
  server = await startConfigRepairServer();
});

afterAll(async () => {
  await server.close();
});

function runInteractiveCli(
  workspace: ConfigRepairWorkspace,
  args: string[],
  answers: InteractiveAnswer[],
  signal: AbortSignal,
  withKey = false,
) {
  return runConfigRepairSession(workspace, args, answers, signal, withKey);
}

describe('real CLI missing-credential repair chain', () => {
  it('start fails before supervision, real Commander repair preserves the slot, and full raw/resolved reads recover', async context => {
    const workspace = createConfigRepairWorkspace(server.baseUrl);
    await finishConfigRepairCase(workspace, async () => {
      server.requests.length = 0;
      const failedStart = await runConfigRepairCli(
        workspace, ['start', '--non-interactive'], context.signal,
      );
      expect(failedStart.status).toBe(3);
      expect(failedStart.stderr).toContain(CONFIG_REPAIR_REF);
      expect(failedStart.stderr).toContain('config provider repair');
      expect(failedStart.stderr).not.toContain('corrupted');
      expect(failedStart.stderr).not.toContain('integration-secret');
      expect(server.requests).toHaveLength(0);
      expect(fs.existsSync(path.join(workspace.root, '.chestnut', 'motion', 'daemon'))).toBe(false);

      const repaired = await runInteractiveCli(workspace, ['config', 'provider', 'repair', 'main'], [
        { prompt: /> : $/, value: '3' },
        { prompt: /New model \(b = back\): $/, value: 'repaired-model' },
      ], context.signal, true);
      expect(repaired.status).toBe(0);
      expect(repaired.execution.kind).toBe('gone');
      expect(repaired.stdout).toContain('repaired in place at revision 2');
      expect(repaired.stderr).not.toContain('integration-secret');
      expect(server.requests.length).toBeGreaterThan(0);

      const configPath = path.join(workspace.root, '.chestnut', 'llm', 'config.yaml');
      const rawText = fs.readFileSync(configPath, 'utf8');
      const raw = yaml.load(rawText) as {
        revision: number;
        primary: { model: string; label: string; api_key: string };
        fallbacks?: unknown[];
      };
      expect(raw.revision).toBe(2);
      expect(raw.primary).toMatchObject({
        model: 'repaired-model', label: 'main', api_key: `\${${CONFIG_REPAIR_REF}}`,
      });
      expect(raw.fallbacks).toBeUndefined();
      expect(rawText).not.toContain('integration-secret');

      const status = await runConfigRepairCli(workspace, ['status'], context.signal, '', true);
      if (status.status !== 0) throw new Error(`status failed: ${status.stderr}`);
      expect(status.status).toBe(0);
      expect(status.stderr).not.toContain('credential unavailable');
      expect(status.stderr).not.toContain('integration-secret');
    }, { requests: () => server.requests });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('缺 key → repair key 写独立 ref，且单字段提交不物化 defaults', async context => {
    const workspace = createConfigRepairWorkspace(server.baseUrl);
    await finishConfigRepairCase(workspace, async () => {
      const repaired = await runInteractiveCli(workspace, ['config', 'provider', 'repair', 'main'], [
        { prompt: /> : $/, value: '2' },
        { prompt: /New API key \(b = back\): $/, value: 'new-cli-secret' },
      ], context.signal);
      if (repaired.status !== 0) throw new Error(`repair key failed: ${repaired.stderr}\n${repaired.stdout}`);
      expect(repaired.execution.kind).toBe('gone');
      expect(repaired.stdout).toContain('repaired in place at revision 2');
      expect(repaired.stdout).not.toContain('new-cli-secret');
      expect(repaired.stderr).not.toContain('new-cli-secret');

      const raw = readConfigRepairRaw(workspace.root);
      expect(raw.document.revision).toBe(2);
      expect(raw.document.primary).toMatchObject({ label: 'main', model: 'original-model' });
      expect(raw.document.primary.api_key).not.toBe(`\${${CONFIG_REPAIR_REF}}`);
      expect(raw.document.primary).not.toHaveProperty('temperature');
      expect(raw.document.primary).not.toHaveProperty('timeout_ms');
      expect(raw.document.fallbacks).toBeUndefined();
      expect(raw.text).not.toContain('new-cli-secret');

      const status = await runConfigRepairCli(workspace, ['status'], context.signal);
      if (status.status !== 0) throw new Error(`status after key repair failed: ${status.stderr}`);
      expect(status.status).toBe(0);
    }, { requests: () => server.requests });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('add 新 primary → 旧坏条目成为 fallback → remove 后完整配置恢复', async context => {
    const workspace = createConfigRepairWorkspace(server.baseUrl);
    await finishConfigRepairCase(workspace, async () => {
      const added = await runInteractiveCli(workspace, ['config', 'provider', 'add'], [
        { prompt: /> : $/, value: '10' },
        { prompt: />  \[2\]: $/, value: '2' },
        { prompt: /Base URL: $/, value: server.baseUrl },
        { prompt: /API Key: $/, value: 'added-secret' },
        { prompt: /Model: $/, value: 'added-model' },
        { prompt: /Continue with this configuration\? \[Y\]: $/, value: 'y' },
        { prompt: /Label .*\[other\]: $/, value: 'added' },
        { prompt: /Role:[\s\S]*>  \[2\]: $/, value: '1' },
        { prompt: /Confirm\? \[N\]: $/, value: 'y' },
      ], context.signal);
      if (added.status !== 0) throw new Error(`provider add failed: ${added.stderr}\n${added.stdout}`);
      expect(added.execution.kind).toBe('gone');
      expect(added.stdout).toContain('Provider "added" is now primary');
      expect(`${added.stdout}\n${added.stderr}`).toContain('not ready');
      const afterAdd = readConfigRepairRaw(workspace.root);
      expect(afterAdd.document.revision).toBe(2);
      expect(afterAdd.document.primary).toMatchObject({ label: 'added', model: 'added-model' });
      expect(afterAdd.document.fallbacks).toHaveLength(1);
      expect(afterAdd.document.fallbacks?.[0]).toMatchObject({
        label: 'main', api_key: `\${${CONFIG_REPAIR_REF}}`,
      });

      const removed = await runConfigRepairCli(
        workspace, ['config', 'provider', 'remove', 'main'], context.signal,
      );
      if (removed.status !== 0) throw new Error(`remove broken fallback failed: ${removed.stderr}`);
      expect(removed.stdout).toContain('Removed provider');
      const afterRemove = readConfigRepairRaw(workspace.root);
      expect(afterRemove.document.revision).toBe(3);
      expect(afterRemove.document.primary).toMatchObject({ label: 'added', model: 'added-model' });
      expect(afterRemove.document.fallbacks ?? []).toHaveLength(0);

      const status = await runConfigRepairCli(workspace, ['status'], context.signal);
      if (status.status !== 0) throw new Error(`status after add/remove failed: ${status.stderr}`);
      expect(status.status).toBe(0);
    }, { requests: () => server.requests });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
