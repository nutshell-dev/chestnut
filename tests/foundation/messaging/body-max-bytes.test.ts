/**
 * phase 1820 (message-size-env-bypass): writer wire-size 上限由配置 owner
 * （messaging config-schema）经装配注入，writer 不读 env、不持默认值。
 *
 * 覆盖：注入小上限的 oversize 拒写（write/writeSync/outbox 三路径）+ audit 交付 +
 * 错误文案无 env 提示 / 默认 limits 回归 / schema 默认与覆盖校验。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InboxWriter, makeInboxPath } from '../../../src/foundation/messaging/inbox-writer.js';
import {
  createOutboxWriter,
  messagingConfigSchema,
  MESSAGING_BODY_MAX_BYTES_DEFAULT,
  MESSAGING_WRITER_LIMITS_DEFAULT,
} from '../../../src/foundation/messaging/index.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

const TINY = { bodyMaxBytes: 256 } as const;
const bigBody = 'x'.repeat(4096);

describe('phase 1820 messaging writer limits 注入', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  beforeEach(async () => {
    tempDir = await createTempDir('chestnut-test-');
    fs = new NodeFileSystem({ baseDir: tempDir });
  });
  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('inbox write 超注入上限 → 拒写 + INBOX_BODY_OVERSIZE audit（cap=注入值）', async () => {
    const { audit, events } = makeAudit();
    const writer = InboxWriter.__internal_create(fs, makeInboxPath('inbox/pending'), audit, TINY);
    await expect(
      writer.write({ id: 'm1', type: 'text', from: 'a', to: 'b', content: bigBody, timestamp: new Date().toISOString(), priority: 'normal' }),
    ).rejects.toThrow(/exceeds cap 256/);
    const evt = events.find(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_BODY_OVERSIZE);
    expect(evt).toBeDefined();
    expect(evt!.join(' ')).toContain('cap=256');
  });

  it('inbox writeSync 超注入上限 → 拒写（同步路径同一 limits 来源）', () => {
    const { audit, events } = makeAudit();
    const writer = InboxWriter.__internal_create(fs, makeInboxPath('inbox/pending'), audit, TINY);
    expect(() =>
      writer.writeSync({ type: 'text', source: 'a', body: bigBody }),
    ).toThrow(/exceeds cap 256/);
    expect(events.some(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_BODY_OVERSIZE)).toBe(true);
  });

  it('outbox write 超注入上限 → 拒写 + 文案无 env 提示（env 覆盖已废止）', async () => {
    const { audit, events } = makeAudit();
    const writer = createOutboxWriter('claw-a' as Parameters<typeof createOutboxWriter>[0], tempDir, fs, audit, TINY);
    await expect(
      writer.write({ type: 'report', to: 'motion', content: bigBody }),
    ).rejects.toThrow(/exceeds cap 256/);
    expect(events.some(e => e[0] === MESSAGING_AUDIT_EVENTS.OUTBOX_BODY_OVERSIZE)).toBe(true);
    const err = await writer.write({ type: 'report', to: 'motion', content: bigBody }).catch(e => e);
    expect(String(err?.message)).not.toContain('env CHESTNUT');
  });

  it('默认 limits（64 KiB）下典型消息正常写入（数值回归）', async () => {
    const { audit } = makeAudit();
    const writer = InboxWriter.__internal_create(fs, makeInboxPath('inbox/pending'), audit, MESSAGING_WRITER_LIMITS_DEFAULT);
    await expect(
      writer.write({ id: 'm2', type: 'text', from: 'a', to: 'b', content: 'hello', timestamp: new Date().toISOString(), priority: 'normal' }),
    ).resolves.toBeUndefined();
    expect(MESSAGING_WRITER_LIMITS_DEFAULT.bodyMaxBytes).toBe(64 * 1024);
  });
});

describe('phase 1820 messagingConfigSchema（配置 owner）', () => {
  it('缺省填充默认 64 KiB（yaml 无 messaging 段 → owner 默认）', () => {
    expect(messagingConfigSchema.parse({}).body_max_bytes).toBe(MESSAGING_BODY_MAX_BYTES_DEFAULT);
  });

  it('yaml 覆盖生效', () => {
    expect(messagingConfigSchema.parse({ body_max_bytes: 128 }).body_max_bytes).toBe(128);
  });

  it.each([0, -1, 1.5, '65536'])('非法值 %s → 校验拒绝', (v) => {
    expect(() => messagingConfigSchema.parse({ body_max_bytes: v })).toThrow();
  });
});
