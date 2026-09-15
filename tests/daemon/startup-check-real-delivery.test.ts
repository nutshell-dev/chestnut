/**
 * phase 1838 Step B: startup check 投递确认——真实 FS + 真实 Messaging + 生产 delivery。
 *
 * 链路：createStartupCheckDelivery（生产）→ 真实 notifyInbox 写盘 → 生产
 * createInboxReader.findByExtraMeta 扫 pending/inflight/done 确认。fault 注入经
 * 真实 fs 代理按目标路径精确匹配；不 vi.mock 任何生产模块。
 *
 * 反向三项：①确认不依赖文件名/错误布尔兜底，查询未知不 fired；②查询只读
 * （不 init/drain/ack）；③正文/type/priority 与冷却行为不变。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as fsNative from 'fs';
import * as path from 'path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';
import { createStartupCheckDelivery, type StartupCheckOutcome } from '../../src/daemon/daemon-loop.js';
import { createInboxReader, notifyInbox } from '../../src/foundation/messaging/index.js';
import { decodeInbox } from '../../src/foundation/messaging/codec-inbox.js';
import { startupCheckMessage } from '../../src/templates/messages/index.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { makeAudit } from '../helpers/audit.js';

/** fs 代理：按目标路径精确注入一次性故障，其余调用透传真实实现。 */
interface Faults {
  /** 命中路径时对 writeAtomicSync 注入：'throw' 写前抛 / 'throw-after-write' 先写后抛。 */
  writeAtomicOnce?: { match: (p: string) => boolean; mode: 'throw' | 'throw-after-write'; err: Error };
  listOnce?: { match: (p: string) => boolean; err: Error };
  listSyncOnce?: { match: (p: string) => boolean; err: Error };
  readSyncOnce?: { match: (p: string) => boolean; err: Error };
}

function wrapFs(base: FileSystem, faults: Faults): { fs: FileSystem } {
  const state = { ...faults };
  const proxy = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'writeAtomicSync' && state.writeAtomicOnce) {
        const f = state.writeAtomicOnce;
        return (p: string, c: string) => {
          if (f.match(p)) {
            state.writeAtomicOnce = undefined;
            if (f.mode === 'throw-after-write') {
              (target.writeAtomicSync as (p: string, c: string) => void).call(target, p, c);
            }
            throw f.err;
          }
          return (target.writeAtomicSync as (p: string, c: string) => void).call(target, p, c);
        };
      }
      if (prop === 'list' && state.listOnce) {
        const f = state.listOnce;
        return async (p: string, opts?: unknown) => {
          if (f.match(p)) {
            state.listOnce = undefined;
            throw f.err;
          }
          return (target.list as (p: string, o?: unknown) => Promise<unknown>).call(target, p, opts);
        };
      }
      if (prop === 'listSync' && state.listSyncOnce) {
        const f = state.listSyncOnce;
        return (p: string, opts?: unknown) => {
          if (f.match(p)) {
            state.listSyncOnce = undefined;
            throw f.err;
          }
          return (target.listSync as (p: string, o?: unknown) => unknown).call(target, p, opts);
        };
      }
      if (prop === 'readSync' && state.readSyncOnce) {
        const f = state.readSyncOnce;
        return (p: string) => {
          if (f.match(p)) {
            state.readSyncOnce = undefined;
            throw f.err;
          }
          return (target.readSync as (p: string) => string).call(target, p);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { fs: proxy as FileSystem };
}

describe('phase 1838: startup check 真实投递确认链', () => {
  let agentDir: string;
  let realAgentFs: NodeFileSystem;
  let clawFs: NodeFileSystem;
  let auditCtx: ReturnType<typeof makeAudit>;
  let pendingDir: string;
  let statusFile: string;

  beforeEach(async () => {
    agentDir = await createTempDir('phase1838-delivery-');
    realAgentFs = new NodeFileSystem({ baseDir: agentDir });
    clawFs = new NodeFileSystem({ baseDir: path.join(agentDir, '..') });
    auditCtx = makeAudit();
    pendingDir = path.join(agentDir, 'inbox', 'pending');
    statusFile = path.join(agentDir, 'status', 'startup_check_ts');
    await fs.mkdir(path.join(agentDir, 'contract', 'active', 'c-live'), { recursive: true });
    await fs.mkdir(pendingDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(agentDir);
  });

  function makeDelivery(agentFs: FileSystem = realAgentFs, claw: FileSystem = clawFs) {
    return createStartupCheckDelivery({ agentFs, clawFs: claw, agentDir, audit: auditCtx.audit });
  }

  async function pendingMessages() {
    const files = (await fs.readdir(pendingDir)).filter(f => f.endsWith('.md'));
    return Promise.all(files.sort().map(async f =>
      decodeInbox(await fs.readFile(path.join(pendingDir, f), 'utf-8'))));
  }

  /** 进入「timestamp 已提交、消息真实写盘但 post-query 失败」的未确认状态。 */
  async function makeUnconfirmedWithRealMessage() {
    const wrapped = wrapFs(realAgentFs, {
      readSyncOnce: {
        match: p => p.includes('inbox/'),
        err: Object.assign(new Error('EACCES post-query'), { code: 'EACCES' }),
      },
    });
    const delivery = makeDelivery(wrapped.fs);
    const first = await delivery.deliver();
    expect(first).toMatchObject({ kind: 'pending_retry', stage: 'notify' });
    expect((first as { error: string }).error).toContain('op=post-query');
    const ts = fsNative.readFileSync(statusFile, 'utf-8');
    expect((await pendingMessages()).length).toBe(1);
    return { delivery, ts };
  }

  it('1. 首次 fired：timestamp 与消息 metadata 一致、恰好一条、正文/envelope 不变', async () => {
    const delivery = makeDelivery();
    const out = await delivery.deliver();
    expect(out.kind).toBe('fired');

    const ts = fsNative.readFileSync(statusFile, 'utf-8');
    expect(Number(ts)).toBeGreaterThan(0);
    expect((out as { timestampMs: number }).timestampMs).toBe(Number(ts));

    const messages = await pendingMessages();
    expect(messages.length).toBe(1);
    const msg = messages[0]!;
    expect(msg.type).toBe('startup_check');
    expect(msg.from).toBe('daemon');
    expect(msg.priority).toBe('high');
    expect(msg.content).toBe(startupCheckMessage());
    expect(msg.metadata?.startup_check_ts).toBe(ts);
  });

  it('2. 完成缓存：再次 deliver 返回同一 fired；真实 drain/ack 移入 done 后仍不重发', async () => {
    const delivery = makeDelivery();
    const first = await delivery.deliver();
    expect(first.kind).toBe('fired');
    expect(await delivery.deliver()).toBe(first);

    // 真实 Messaging 移动：pending → inflight → done
    const reader = createInboxReader(realAgentFs, auditCtx.audit, 'inbox');
    const batch = await reader.drainAndDeliver();
    expect(batch.handles.length).toBe(1);
    await reader.ack(batch.handles[0]!);
    expect((await fs.readdir(path.join(agentDir, 'inbox', 'done'))).length).toBe(1);

    const third = await delivery.deliver();
    expect(third).toBe(first);
    expect((await fs.readdir(pendingDir)).filter(f => f.endsWith('.md')).length).toBe(0);
  });

  it('3. timestamp 写前 EIO → timestamp pending_retry、零消息；恢复后 fired', async () => {
    const wrapped = wrapFs(realAgentFs, {
      writeAtomicOnce: {
        match: p => p.endsWith('startup_check_ts'),
        mode: 'throw',
        err: Object.assign(new Error('EIO ts'), { code: 'EIO' }),
      },
    });
    const delivery = makeDelivery(wrapped.fs);

    const first = await delivery.deliver();
    expect(first).toMatchObject({ kind: 'pending_retry', stage: 'timestamp' });
    expect((first as { error: string }).error).toContain('EIO ts');
    expect((await pendingMessages()).length).toBe(0);
    expect(fsNative.existsSync(statusFile)).toBe(false);

    const second = await delivery.deliver();
    expect(second.kind).toBe('fired');
    expect((await pendingMessages()).length).toBe(1);
  });

  it('4. 仅消息写前失败 → notify pending_retry；移走 active 恢复 FS 后 fired、timestamp 不变', async () => {
    const wrappedClaw = wrapFs(clawFs, {
      writeAtomicOnce: {
        match: p => p.includes('inbox/pending'),
        mode: 'throw',
        err: Object.assign(new Error('EIO msg'), { code: 'EIO' }),
      },
    });
    const delivery = makeDelivery(realAgentFs, wrappedClaw.fs);

    const first = await delivery.deliver();
    expect(first).toMatchObject({ kind: 'pending_retry', stage: 'notify' });
    expect((await pendingMessages()).length).toBe(0);
    const tsBefore = fsNative.readFileSync(statusFile, 'utf-8');

    // active 移走（timestamp 已提交后 bypass eligibility 重评估）
    await fs.rename(
      path.join(agentDir, 'contract', 'active', 'c-live'),
      path.join(agentDir, 'contract', 'c-live-archived'),
    );

    const second = await delivery.deliver();
    expect(second.kind).toBe('fired');
    expect(fsNative.readFileSync(statusFile, 'utf-8')).toBe(tsBefore);
    const messages = await pendingMessages();
    expect(messages.length).toBe(1);
    expect(messages[0]!.metadata?.startup_check_ts).toBe(tsBefore);
  });

  it('5. 消息写后抛错（真实记录已在盘）→ post-query 确认 fired、一条消息、保留失败审计', async () => {
    const wrappedClaw = wrapFs(clawFs, {
      writeAtomicOnce: {
        match: p => p.includes('inbox/pending'),
        mode: 'throw-after-write',
        err: Object.assign(new Error('EIO after write'), { code: 'EIO' }),
      },
    });
    const delivery = makeDelivery(realAgentFs, wrappedClaw.fs);

    const out = await delivery.deliver();
    expect(out.kind).toBe('fired');
    expect((await pendingMessages()).length).toBe(1);
    // Messaging 既有的写失败审计未被异常吞没
    expect(auditCtx.events.some(e => e[0] === 'inbox_write_failed')).toBe(true);
  });

  it('6a. pre-query list 异常 → pending_retry 含 op/错误、不写消息；恢复后收敛 fired', async () => {
    const wrapped = wrapFs(realAgentFs, {
      listOnce: {
        match: p => p.includes('inbox'),
        err: Object.assign(new Error('EIO pre-query list'), { code: 'EIO' }),
      },
    });
    const delivery = makeDelivery(wrapped.fs);

    const first = await delivery.deliver();
    expect(first).toMatchObject({ kind: 'pending_retry', stage: 'notify' });
    expect((first as { error: string }).error).toContain('op=pre-query');
    expect((first as { error: string }).error).toContain('EIO pre-query list');
    expect((await pendingMessages()).length).toBe(0);
    // 查询失败不误 fired、不盲发，但 timestamp 已提交保留
    expect(fsNative.existsSync(statusFile)).toBe(true);

    const second = await delivery.deliver();
    expect(second.kind).toBe('fired');
    expect((await pendingMessages()).length).toBe(1);
  });

  it('6b. post-query read 异常（真实 fs 代理注入）→ pending_retry 而非 fired；恢复后确认不重写', async () => {
    const { delivery } = await makeUnconfirmedWithRealMessage();
    const second = await delivery.deliver();
    expect(second.kind).toBe('fired');
    expect((await pendingMessages()).length).toBe(1);
  });

  it('7a. 未确认消息 drain 到 inflight 后仍确认 fired、无新消息', async () => {
    const { delivery } = await makeUnconfirmedWithRealMessage();
    const reader = createInboxReader(realAgentFs, auditCtx.audit, 'inbox');
    const batch = await reader.drainAndDeliver();
    expect(batch.handles.length).toBe(1);

    const out = await delivery.deliver();
    expect(out.kind).toBe('fired');
    expect((await pendingMessages()).length).toBe(0);
    expect((await fs.readdir(path.join(agentDir, 'inbox', 'inflight'))).length).toBe(1);
  });

  it('7b. 未确认消息 ack 到 done 且 mtime 置旧仍命中（Infinity 窗口）、无新消息', async () => {
    const { delivery } = await makeUnconfirmedWithRealMessage();
    const reader = createInboxReader(realAgentFs, auditCtx.audit, 'inbox');
    const batch = await reader.drainAndDeliver();
    await reader.ack(batch.handles[0]!);
    const doneDir = path.join(agentDir, 'inbox', 'done');
    const doneFile = (await fs.readdir(doneDir))[0]!;
    const epoch = new Date(0);
    fsNative.utimesSync(path.join(doneDir, doneFile), epoch, epoch);

    const out = await delivery.deliver();
    expect(out.kind).toBe('fired');
    expect((await pendingMessages()).length).toBe(0);
  });

  it('7c. 其他关联值的历史消息不确认本次请求', async () => {
    // 未确认且无消息：pre-query list 一次性异常
    const wrapped = wrapFs(realAgentFs, {
      listOnce: {
        match: p => p.includes('inbox'),
        err: Object.assign(new Error('EIO pre-query'), { code: 'EIO' }),
      },
    });
    const delivery = makeDelivery(wrapped.fs);
    const first = await delivery.deliver();
    expect(first).toMatchObject({ kind: 'pending_retry', stage: 'notify' });
    const ts = fsNative.readFileSync(statusFile, 'utf-8');

    // 真实写入一条其他 startup_check_ts 的消息
    notifyInbox(clawFs, {
      inboxDir: pendingDir,
      type: 'startup_check',
      source: 'daemon',
      priority: 'high',
      body: startupCheckMessage(),
      metadata: { startup_check_ts: '999999' },
    }, auditCtx.audit);
    expect((await pendingMessages()).length).toBe(1);

    const second = await delivery.deliver();
    expect(second.kind).toBe('fired');
    const messages = await pendingMessages();
    // 其他关联值不命中 → 补写本次消息；共两条、归属各自 timestamp
    expect(messages.length).toBe(2);
    expect(messages.filter(m => m.metadata?.startup_check_ts === ts).length).toBe(1);
    expect(messages.filter(m => m.metadata?.startup_check_ts === '999999').length).toBe(1);
  });

  it('8. 未确认消息移入 failed 不作为成功证据：允许重发、保留 failed 记录', async () => {
    const { delivery } = await makeUnconfirmedWithRealMessage();
    const reader = createInboxReader(realAgentFs, auditCtx.audit, 'inbox');
    const pendingFile = (await fs.readdir(pendingDir))[0]!;
    await reader.markFailed(path.join(pendingDir, pendingFile));
    expect((await pendingMessages()).length).toBe(0);
    expect((await fs.readdir(path.join(agentDir, 'inbox', 'failed'))).length).toBe(1);

    const out = await delivery.deliver();
    expect(out.kind).toBe('fired');
    // 一条失败记录 + 一条新 pending
    expect((await fs.readdir(path.join(agentDir, 'inbox', 'failed'))).length).toBe(1);
    expect((await pendingMessages()).length).toBe(1);
  });

  it('9. eligibility：无 active / 仅 .creating / pending 非空 / 有效冷却 → not_eligible、零写盘', async () => {
    async function freshDir(setup: (dir: string) => Promise<void>): Promise<string> {
      const dir = await createTempDir('phase1838-elig-');
      await fs.mkdir(path.join(dir, 'inbox', 'pending'), { recursive: true });
      await setup(dir);
      return dir;
    }
    const cases: Array<{ name: string; dir: string }> = [];
    try {
      cases.push({ name: 'no-active', dir: await freshDir(async () => { /* no contract */ }) });
      cases.push({
        name: 'only-creating',
        dir: await freshDir(async dir => {
          await fs.mkdir(path.join(dir, 'contract', 'active', 'c-new'), { recursive: true });
          await fs.writeFile(path.join(dir, 'contract', 'active', 'c-new', '.creating'), '');
        }),
      });
      cases.push({
        name: 'pending-nonempty',
        dir: await freshDir(async dir => {
          await fs.mkdir(path.join(dir, 'contract', 'active', 'c-live'), { recursive: true });
          await fs.writeFile(path.join(dir, 'inbox', 'pending', 'other-1_normal_x.md'), 'x');
        }),
      });
      cases.push({
        name: 'fresh-cooldown',
        dir: await freshDir(async dir => {
          await fs.mkdir(path.join(dir, 'contract', 'active', 'c-live'), { recursive: true });
          await fs.mkdir(path.join(dir, 'status'), { recursive: true });
          await fs.writeFile(path.join(dir, 'status', 'startup_check_ts'), String(Date.now()));
        }),
      });

      for (const tc of cases) {
        const delivery = createStartupCheckDelivery({
          agentFs: new NodeFileSystem({ baseDir: tc.dir }),
          clawFs: new NodeFileSystem({ baseDir: path.join(tc.dir, '..') }),
          agentDir: tc.dir,
          audit: auditCtx.audit,
        });
        const out: StartupCheckOutcome = await delivery.deliver();
        expect(out.kind, tc.name).toBe('not_eligible');
        expect(fsNative.existsSync(path.join(tc.dir, 'status', 'startup_check_ts')), tc.name).toBe(
          tc.name === 'fresh-cooldown',
        );
        expect((await fs.readdir(path.join(tc.dir, 'inbox', 'pending')))
          .filter(f => f.endsWith('.md') && f !== 'other-1_normal_x.md').length, tc.name).toBe(0);
      }
    } finally {
      for (const tc of cases) await cleanupTempDir(tc.dir);
    }
  });

  it('9b. pending count 读取失败 → not_eligible（不伪称可投递），留有 IO 审计', async () => {
    const wrapped = wrapFs(realAgentFs, {
      listSyncOnce: {
        match: p => p.includes('inbox/pending'),
        err: Object.assign(new Error('EIO count'), { code: 'EIO' }),
      },
    });
    const delivery = makeDelivery(wrapped.fs);
    const out = await delivery.deliver();
    expect(out.kind).toBe('not_eligible');
    expect(fsNative.existsSync(statusFile)).toBe(false);
    expect((await pendingMessages()).length).toBe(0);
    expect(auditCtx.events.some(e => e[0] === 'daemon_startup_check_io_error')).toBe(true);
  });
});
