import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { notifyRunningDaemons } from '../../../src/cli/commands/config.js';
import {
  createLLMConfigurationDocumentStore,
  createLLMNotificationStore,
  getLLMConfigurationPath,
  type ExplicitLLMProviderConfig,
  type LLMNotificationFact,
} from '../../../src/core/llm-configuration/index.js';
import { makeDaemonDir } from '../../../src/foundation/process-manager/index.js';
import { captureOwnedProcessRef } from '../../../src/foundation/process-exec/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { AtomicWriteResult } from '../../../src/foundation/fs/index.js';
import { formatErr, sha256Hex } from '../../../src/foundation/node-utils/index.js';
import { writeActiveGenerationSync } from '../../helpers/generation-fixtures.js';
import { cleanupTempDirSync, createTrackedTempDirSync } from '../../utils/temp.js';

const CREDENTIALS_PATH = () => path.join(tmpDir, '.chestnut', 'llm', 'credentials.yaml');
const CREDENTIALS = 'version: 1\nrefs:\n  PHASE2237_NOTIFY_KEY: local-fixture-only\n';

type NotificationStatus = LLMNotificationFact['status'];
type FaultNotificationStatus = Extract<NotificationStatus, 'pending' | 'sent' | 'failed'>;
type TargetWrite = 'inbox' | NotificationStatus;

interface FaultInjection {
  inboxBeforeWrite?: Error;
  notificationBeforeWrite?: {
    status: FaultNotificationStatus;
    error: Error;
  };
  sentAfterWrite?: {
    kind: 'committed_platform_limited' | 'committed_durability_unknown';
    error: NodeJS.ErrnoException;
  };
}

interface FaultControl {
  armed?: FaultInjection;
  notificationFile?: string;
  readonly attempts: TargetWrite[];
}

class FaultFs extends NodeFileSystem {
  constructor(
    baseDir: string,
    rootDir: string,
    private readonly control: FaultControl,
  ) {
    super({ baseDir });
    this.inboxDir = path.join(rootDir, '.chestnut', 'motion', 'inbox', 'pending');
  }

  private readonly inboxDir: string;

  override writeAtomicSync(relativePath: string, content: string): AtomicWriteResult {
    const target = this.resolve(relativePath);
    const targetWrite = this.targetWrite(target, content);
    if (targetWrite === undefined) return super.writeAtomicSync(relativePath, content);

    this.control.attempts.push(targetWrite);
    const fault = this.control.armed;
    if (fault === undefined) return super.writeAtomicSync(relativePath, content);
    if (targetWrite === 'inbox' && fault.inboxBeforeWrite !== undefined) {
      throw fault.inboxBeforeWrite;
    }
    if (targetWrite !== 'inbox' && fault.notificationBeforeWrite?.status === targetWrite) {
      throw fault.notificationBeforeWrite.error;
    }
    if (targetWrite === 'sent' && fault.sentAfterWrite !== undefined) {
      // The sent fact must really reach disk before the caller receives the
      // degraded atomic-write result; this is not a pre-write failure.
      super.writeAtomicSync(relativePath, content);
      return { kind: fault.sentAfterWrite.kind, error: fault.sentAfterWrite.error };
    }
    return super.writeAtomicSync(relativePath, content);
  }

  private targetWrite(target: string, content: string): TargetWrite | undefined {
    if (path.dirname(target) === this.inboxDir && path.extname(target) === '.md') return 'inbox';
    if (target !== this.control.notificationFile) return undefined;
    if (!/^schema_version: 1$/m.test(content)) {
      throw new Error(`Unexpected notification schema in injected write: ${target}`);
    }
    const status = content.match(/^status: (pending|sent|failed|offline)$/m)?.[1];
    switch (status) {
      case 'pending':
      case 'sent':
      case 'failed':
      case 'offline':
        return status;
      default:
        throw new Error(`Unexpected notification status in injected write: ${target}`);
    }
  }
}

let tmpDir: string;
let consoleErrors: string[];

beforeEach(() => {
  tmpDir = fs.realpathSync(createTrackedTempDirSync('chestnut-phase2237-notify-persistence-'));
  vi.stubEnv('CHESTNUT_ROOT', tmpDir);
  const llmDir = path.join(tmpDir, '.chestnut', 'llm');
  fs.mkdirSync(llmDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(llmDir, 0o700);
  fs.writeFileSync(CREDENTIALS_PATH(), CREDENTIALS, { mode: 0o600 });
  fs.chmodSync(CREDENTIALS_PATH(), 0o600);
  consoleErrors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cleanupTempDirSync(tmpDir);
});

function provider(model: string): ExplicitLLMProviderConfig {
  return {
    provider_id: 'custom:anthropic',
    api_format: 'anthropic',
    auth_profile: 'api_key',
    api_key: '${PHASE2237_NOTIFY_KEY}',
    label: 'phase2237-notify',
    model,
    base_url: 'https://phase2237.example.test',
  };
}

async function saveRealConfiguration() {
  const control: FaultControl = { attempts: [] };
  const fsDeps = {
    fsFactory: (baseDir: string) => new FaultFs(baseDir, tmpDir, control),
  };
  const store = createLLMConfigurationDocumentStore(fsDeps);
  const initialized = await store.commitExplicitProvider(
    { kind: 'initialize' },
    provider('before-repair'),
  );
  expect(initialized.revision).toEqual({ id: '1', revision: 1 });

  const saved = await store.commitExplicitProvider(
    { kind: 'replace', slot: { role: 'primary' } },
    provider('after-repair'),
    store.read().revision,
  );
  expect(saved.revision).toEqual({ id: '2', revision: 2 });
  expect(saved.document.primary.model).toBe('after-repair');

  const deps = {
    ...fsDeps,
    llmConfiguration: { readRevision: () => store.readRevision() },
  };
  const rawText = fs.readFileSync(getLLMConfigurationPath(), 'utf8');
  const credentialsText = fs.readFileSync(CREDENTIALS_PATH(), 'utf8');

  const identity = captureOwnedProcessRef(process.pid);
  writeActiveGenerationSync(makeDaemonDir(path.join(tmpDir, '.chestnut', 'motion')), {
    generationId: 'phase2237-g-motion',
    pid: process.pid,
    ...(identity.kind === 'captured'
      ? { processRef: identity.value, startTime: identity.target.startTime }
      : {}),
  });

  return {
    control,
    deps,
    store,
    saved,
    rawText,
    credentialsText,
    arm(fault: FaultInjection): void {
      // The exact current-revision fact is the only notification file eligible
      // for injection, and arming is impossible until the real replace returns.
      control.notificationFile = path.join(
        tmpDir,
        '.chestnut',
        'llm',
        'notifications',
        `${sha256Hex(`${saved.revision.id}\0motion`)}.yaml`,
      );
      control.armed = fault;
    },
  };
}

type SavedFixture = Awaited<ReturnType<typeof saveRealConfiguration>>;

function readNotification(fixture: SavedFixture): LLMNotificationFact | undefined {
  return createLLMNotificationStore(fixture.deps).read(fixture.saved.revision.id, 'motion');
}

function expectConfigurationUnchanged(fixture: SavedFixture): void {
  expect(fixture.store.read()).toEqual(fixture.saved.document);
  expect(fixture.store.readRevision()).toEqual(fixture.saved.revision);
  expect(fs.readFileSync(getLLMConfigurationPath(), 'utf8')).toBe(fixture.rawText);
  expect(fs.readFileSync(CREDENTIALS_PATH(), 'utf8')).toBe(fixture.credentialsText);
}

function readMotionInbox(): string[] {
  const inboxDir = path.join(tmpDir, '.chestnut', 'motion', 'inbox', 'pending');
  if (!fs.existsSync(inboxDir)) return [];
  return fs.readdirSync(inboxDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => fs.readFileSync(path.join(inboxDir, entry.name), 'utf8'));
}

function expectDeliveredReload(fixture: SavedFixture): void {
  const messages = readMotionInbox();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('type: reload_llm_config');
  expect(messages[0]).toMatch(/from:\s*["']?cli-repair["']?/);
  expect(messages[0]).toMatch(new RegExp(`llm_revision:\\s*["']?${fixture.saved.revision.id}["']?`));
}

function readAudit(): string {
  return fs.readFileSync(path.join(tmpDir, '.chestnut', 'audit.tsv'), 'utf8');
}

describe('Phase 2237 Step G: real persisted notification failure boundaries', () => {
  it('F01: inbox pre-write failure preserves the commit and persists failed delivery evidence', async () => {
    const fixture = await saveRealConfiguration();
    const deliveryFailure = Object.assign(new Error('F01 controlled inbox pre-write failure'), { code: 'EIO' });
    fixture.arm({ inboxBeforeWrite: deliveryFailure });

    await expect(notifyRunningDaemons(fixture.deps, 'repair', fixture.saved.revision)).resolves.toBeUndefined();

    expectConfigurationUnchanged(fixture);
    expect(fixture.control.attempts).toEqual(['pending', 'inbox', 'failed']);
    expect(readMotionInbox()).toEqual([]);
    const fact = readNotification(fixture);
    expect(fact).toMatchObject({
      schema_version: 1,
      revision: fixture.saved.revision.id,
      target: 'motion',
      status: 'failed',
    });
    expect(fact?.error).toBe(formatErr(deliveryFailure).slice(0, 500));
    const audit = readAudit();
    expect(audit).toContain('inbox_write_failed');
    expect(audit).toContain(formatErr(deliveryFailure));
    expect(consoleErrors).toEqual([]);
  });

  it('F02: pending pre-write failure is reported once without retrying or blocking sent delivery', async () => {
    const fixture = await saveRealConfiguration();
    const pendingFailure = Object.assign(new Error('F02 controlled pending pre-write failure'), { code: 'ENOSPC' });
    fixture.arm({ notificationBeforeWrite: { status: 'pending', error: pendingFailure } });

    await expect(notifyRunningDaemons(fixture.deps, 'repair', fixture.saved.revision)).resolves.toBeUndefined();

    expectConfigurationUnchanged(fixture);
    expect(fixture.control.attempts).toEqual(['pending', 'inbox', 'sent']);
    expectDeliveredReload(fixture);
    expect(readNotification(fixture)).toMatchObject({
      revision: fixture.saved.revision.id,
      target: 'motion',
      status: 'sent',
    });
    expect(consoleErrors).toHaveLength(1);
    expect(consoleErrors[0]).toContain('LLM notification fact persistence failed for motion');
    expect(consoleErrors[0]).toContain(formatErr(pendingFailure));
  });

  it('F03: sent pre-write failure leaves the real pending fact after actual inbox delivery', async () => {
    const fixture = await saveRealConfiguration();
    const sentFailure = Object.assign(new Error('F03 controlled sent pre-write failure'), { code: 'EIO' });
    fixture.arm({ notificationBeforeWrite: { status: 'sent', error: sentFailure } });

    await expect(notifyRunningDaemons(fixture.deps, 'repair', fixture.saved.revision)).resolves.toBeUndefined();

    expectConfigurationUnchanged(fixture);
    expect(fixture.control.attempts).toEqual(['pending', 'inbox', 'sent']);
    expectDeliveredReload(fixture);
    const fact = readNotification(fixture);
    expect(fact).toMatchObject({
      revision: fixture.saved.revision.id,
      target: 'motion',
      status: 'pending',
    });
    expect(fact?.error).toBeUndefined();
    expect(consoleErrors).toHaveLength(1);
    expect(consoleErrors[0]).toContain('LLM notification fact persistence failed for motion');
    expect(consoleErrors[0]).toContain(formatErr(sentFailure));
  });

  it.each([
    { code: 'EPERM', kind: 'committed_platform_limited' },
    { code: 'EIO', kind: 'committed_durability_unknown' },
  ] as const)('F04: $kind is delivered after the sent fact is really written', async scenario => {
    const fixture = await saveRealConfiguration();
    const degradedError = Object.assign(
      new Error(`F04 controlled post-write durability failure: ${scenario.kind}`),
      { code: scenario.code },
    );
    fixture.arm({ sentAfterWrite: { kind: scenario.kind, error: degradedError } });

    await expect(notifyRunningDaemons(fixture.deps, 'repair', fixture.saved.revision)).resolves.toBeUndefined();

    expectConfigurationUnchanged(fixture);
    expect(fixture.control.attempts).toEqual(['pending', 'inbox', 'sent']);
    expectDeliveredReload(fixture);
    expect(readNotification(fixture)).toMatchObject({
      revision: fixture.saved.revision.id,
      target: 'motion',
      status: 'sent',
    });
    expect(consoleErrors).toHaveLength(1);
    expect(consoleErrors[0]).toContain('LLM notification fact for motion committed with degraded durability');
    expect(consoleErrors[0]).toContain(`kind=${scenario.kind}`);
    expect(consoleErrors[0]).toContain(formatErr(degradedError));
  });

  it('F05: delivery failure and failed-fact persistence failure retain separate visible evidence', async () => {
    const fixture = await saveRealConfiguration();
    const deliveryFailure = Object.assign(new Error('F05 controlled inbox delivery failure'), { code: 'EIO' });
    const failedFactFailure = Object.assign(new Error('F05 controlled failed-fact pre-write failure'), { code: 'ENOSPC' });
    fixture.arm({
      inboxBeforeWrite: deliveryFailure,
      notificationBeforeWrite: { status: 'failed', error: failedFactFailure },
    });

    await expect(notifyRunningDaemons(fixture.deps, 'repair', fixture.saved.revision)).resolves.toBeUndefined();

    expectConfigurationUnchanged(fixture);
    expect(fixture.control.attempts).toEqual(['pending', 'inbox', 'failed']);
    expect(readMotionInbox()).toEqual([]);
    const fact = readNotification(fixture);
    expect(fact).toMatchObject({
      revision: fixture.saved.revision.id,
      target: 'motion',
      status: 'pending',
    });
    expect(fact?.error).toBeUndefined();

    const audit = readAudit();
    expect(audit).toContain('inbox_write_failed');
    expect(audit).toContain(formatErr(deliveryFailure));
    expect(audit).not.toContain(formatErr(failedFactFailure));
    expect(consoleErrors).toHaveLength(1);
    expect(consoleErrors[0]).toContain('LLM notification fact persistence failed for motion');
    expect(consoleErrors[0]).toContain(formatErr(failedFactFailure));
    expect(consoleErrors[0]).not.toContain(deliveryFailure.message);
  });
});
