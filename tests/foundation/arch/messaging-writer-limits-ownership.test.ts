/**
 * phase 1820 (message-size-env-bypass) arch ratchet：
 * messaging writer 的 wire-size 上限归配置 owner（config-schema），
 * writer 不读 env、不持默认值，装配层注入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('Messaging body-size config ownership（phase 1820）', () => {
  it('writer 无 process.env 访问、无 BODY_MAX_BYTES 默认常量（默认归 config-schema）', () => {
    for (const f of ['src/foundation/messaging/inbox-writer.ts', 'src/foundation/messaging/outbox-writer.ts']) {
      const src = read(f);
      expect(src).not.toMatch(/process\.env/);
      expect(src).not.toMatch(/BODY_MAX_BYTES_DEFAULT/);
      // 构造期必需 limits capability
      expect(src).toMatch(/limits: MessagingWriterLimits/);
      expect(src).toMatch(/this\.limits\.bodyMaxBytes/);
    }
  });

  it('默认值与 limits capability 归 messaging config-schema（单源）', () => {
    const schema = read('src/foundation/messaging/config-schema.ts');
    expect(schema).toMatch(/MESSAGING_BODY_MAX_BYTES_DEFAULT = 64 \* 1024/);
    expect(schema).toMatch(/body_max_bytes: z\.number\(\)/);
    expect(schema).toMatch(/MESSAGING_WRITER_LIMITS_DEFAULT/);
  });

  it('compose-config 注册 messaging 段（yaml messaging.body_max_bytes）', () => {
    expect(read('src/assembly/config/compose-config.ts'))
      .toMatch(/messaging: messagingConfigSchema\.default\(\{\}\)/);
  });

  it('装配层注入 globalConfig 值（core-infrastructure 唯一计算点）', () => {
    const ci = read('src/assembly/core-infrastructure.ts');
    expect(ci).toMatch(/bodyMaxBytes: globalConfig\.messaging\.body_max_bytes/);
    // business-systems 不重复计算、只消费 core 暴露的 limits
    const bs = read('src/assembly/business-systems.ts');
    expect(bs).not.toMatch(/globalConfig\.messaging/);
    expect(bs).toMatch(/messagingLimits/);
  });

  it('outbox 错误文案不再提示 env 覆盖（env 覆盖已废止）', () => {
    expect(read('src/foundation/messaging/outbox-writer.ts')).not.toMatch(/env CHESTNUT/);
  });
});
