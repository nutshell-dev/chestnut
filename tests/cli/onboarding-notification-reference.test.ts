/**
 * Phase 2094 Step B：onboarding 工作消息携带契约身份（真实生产路径落盘核证）。
 *
 * 不走 mock notify 参数：初始化隔离 CHESTNUT_ROOT 与 motion 目录，调用真实
 * `ensureOnboardingAndNotify`，用**真实** `createClawNotifier` + 真实目标 resolver
 * 投递，再解码磁盘上的实际 inbox 文件断言 `metadata.contract_id`。
 *
 * 覆盖两条生产分支：
 * - 首次 not_found → 真实创建 onboarding 契约 → `contract_created`
 * - 已有未完成契约 → `contract_resume`
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';

import { ensureOnboardingAndNotify, getOnboardingStatus } from '../../src/cli/start-bootstrap.js';
import type { StartBootstrapDeps } from '../../src/cli/start-bootstrap.js';
import { createClawNotifier } from '../../src/foundation/messaging/index.js';
import type { InboxMessage } from '../../src/foundation/messaging/index.js';
import { decodeInbox } from '../../src/foundation/messaging/index.js';
import { makeClawNotifyTargetResolver, MOTION_CLAW_ID } from '../../src/core/claw-topology/index.js';
import {
  getContractWorkMessageId,
  ONBOARDING_CONTRACT_ID,
} from '../../src/core/contract/index.js';
import { makeChestnutRoot } from '../../src/foundation/claw-identity/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { makeMockAudit } from '../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

/** rootConfig 在本路径（onboarding notify）未被使用——显式 stub，任何访问都视为测试缺陷。 */
function unusedRootConfig(): StartBootstrapDeps['rootConfig'] {
  const fail = (name: string) => () => {
    throw new Error(`rootConfig.${name} must not be used by onboarding notify path`);
  };
  return {
    loadGlobal: fail('loadGlobal'),
    patchPrimary: fail('patchPrimary'),
    getInitializationState: fail('getInitializationState'),
  } as unknown as StartBootstrapDeps['rootConfig'];
}

describe('phase 2094 Step B: onboarding work messages carry contract references', () => {
  let tempDir: string;
  let motionDir: string;
  let pendingDir: string;
  let prevRoot: string | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir();
    prevRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tempDir;
    // getChestnutRoot() = path.resolve(CHESTNUT_ROOT, '.chestnut')——隔离根下再套一层
    motionDir = path.join(tempDir, '.chestnut', MOTION_CLAW_ID);
    pendingDir = path.join(motionDir, 'inbox', 'pending');
    await fs.mkdir(motionDir, { recursive: true });
    await fs.mkdir(path.join(tempDir, '.chestnut', 'claws'), { recursive: true });
  });

  afterEach(async () => {
    if (prevRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = prevRoot;
    await cleanupTempDir(tempDir);
  });

  /** 真实 notifier + 真实目标 resolver：投递到 <CHESTNUT_ROOT>/motion/inbox/pending。 */
  function realNotifier() {
    return createClawNotifier({
      fs: fsFactory(motionDir),
      audit: makeMockAudit(),
      resolveTarget: makeClawNotifyTargetResolver(makeChestnutRoot(path.dirname(motionDir))),
    });
  }

  /** 解码磁盘上实际投递的消息（不依赖 mock 参数）。 */
  async function readDelivered(): Promise<InboxMessage[]> {
    const files = (await fs.readdir(pendingDir).catch(() => [] as string[])).sort();
    return Promise.all(
      files.map(async (file) =>
        decodeInbox(await fs.readFile(path.join(pendingDir, file), 'utf-8')),
      ),
    );
  }

  it('首次 not_found：真实创建契约并把 contract_id 落到磁盘 metadata', async () => {
    const deps: StartBootstrapDeps = { fsFactory, rootConfig: unusedRootConfig() };

    const result = await ensureOnboardingAndNotify(deps, {
      motionDir,
      onboarding: { state: 'not_found' },
      firstRun: true,
      language: 'auto',
      clawNotifier: realNotifier(),
    });

    expect(result.state).toBe('created');
    expect(result.contractId).toBe(ONBOARDING_CONTRACT_ID);

    // 真实契约确实落盘（不是伪造 result）
    const contractYaml = await fs.readFile(
      path.join(motionDir, 'contract', 'active', ONBOARDING_CONTRACT_ID, 'contract.yaml'),
      'utf-8',
    );
    expect(contractYaml).toContain('title: Onboarding');

    const delivered = await readDelivered();
    const created = delivered.find((m) => m.type === 'contract_created');
    expect(created).toBeDefined();
    if (!created) return;

    // 生产落盘的新消息必须带 ID，且与返回 contractId 一致
    expect(created.from).toBe('system');
    expect(created.priority).toBe('high');
    expect(created.metadata?.contract_id).toBe(result.contractId);
    // body 内原契约 ID 与 metadata 一致
    expect(created.content).toContain(result.contractId);
    // owner 纯入口对真实解码消息给出同一 ID（B 两半端到端对齐）
    expect(getContractWorkMessageId(created)).toBe(result.contractId);
  }, 30_000);

  it('已有未完成契约：resume 消息同样携带 contract_id，body/priority 保持', async () => {
    const deps: StartBootstrapDeps = { fsFactory, rootConfig: unusedRootConfig() };

    // 先用真实生产路径创建，再用真实状态读取进入 resume 分支
    const first = await ensureOnboardingAndNotify(deps, {
      motionDir,
      onboarding: { state: 'not_found' },
      firstRun: false,
      language: 'auto',
      clawNotifier: realNotifier(),
    });
    expect(first.state).toBe('created');

    // 清空首轮投递，保证第二轮断言只看到 resume 消息
    for (const file of await fs.readdir(pendingDir)) {
      await fs.rm(path.join(pendingDir, file), { force: true });
    }

    const status = getOnboardingStatus(motionDir, deps);
    expect(status.state).toBe('in_progress');
    if (status.state !== 'in_progress') return;

    const resumed = await ensureOnboardingAndNotify(deps, {
      motionDir,
      onboarding: status,
      firstRun: false,
      language: 'auto',
      clawNotifier: realNotifier(),
    });

    expect(resumed.state).toBe('resumed');
    expect(resumed.contractId).toBe(status.contractId);

    const delivered = await readDelivered();
    expect(delivered).toHaveLength(1);
    const resume = delivered[0];
    expect(resume.type).toBe('contract_resume');
    expect(resume.from).toBe('system');
    expect(resume.priority).toBe('high');
    expect(resume.metadata?.contract_id).toBe(status.contractId);
    expect(resume.content).toContain(status.contractId);
    expect(getContractWorkMessageId(resume)).toBe(status.contractId);
  }, 30_000);
});
