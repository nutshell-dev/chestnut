/**
 * Phase 1464 Step B: daemon spawn specification 唯一 owner capability 纯函数测试。
 *
 * 锁定 createDaemonSpawnOptions 返回的完整启动协议：command、resolved entry、
 * identity argv、log path、CHESTNUT_ROOT env 与 cwd（含 CLI 路径统一显式 cwd 的
 * 协议收敛）。helper 零 I/O、零 spawn、不持状态。
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import { createDaemonSpawnOptions } from '../../src/daemon/index.js';
import { resolveDaemonEntry } from '../../src/daemon/index.js';
import { DAEMON_LOG, EXPECTED_LLM_IDENTITY_ENV } from '../../src/daemon/index.js';
import { makeClawId, makeChestnutRoot } from '../../src/foundation/claw-identity/index.js';

const SENTINEL_ENV = 'PHASE1464_TEST_SENTINEL';

afterEach(() => {
  delete process.env[SENTINEL_ENV];
});

describe('createDaemonSpawnOptions (Phase 1464)', () => {
  it('返回完整 spawn specification：command/entry/identity/log/env/cwd', () => {
    const input = {
      clawId: makeClawId('test-claw'),
      agentDir: '/ws/.chestnut/claws/test-claw',
      // Phase 1930 Step B：输入为实例根；child CHESTNUT_ROOT env 与 cwd 由 owner
      // 私有推导为 legacy 父目录。
      chestnutRoot: makeChestnutRoot('/ws/.chestnut'),
    };
    const options = createDaemonSpawnOptions(input);

    expect(options.command).toBe('node');
    expect(options.args).toEqual([resolveDaemonEntry(), 'test-claw']);
    expect(options.logFile).toBe(path.join(input.agentDir, DAEMON_LOG));
    expect(options.logFile).toBe('/ws/.chestnut/claws/test-claw/logs/daemon.log');
    expect(options.env?.CHESTNUT_ROOT).toBe('/ws');
    expect(options.cwd).toBe('/ws');
  });

  it('env 继承调用时刻 process.env，且不 mutate process.env', () => {
    process.env[SENTINEL_ENV] = 'present';
    const options = createDaemonSpawnOptions({
      clawId: makeClawId('motion'),
      agentDir: '/ws/.chestnut/motion',
      chestnutRoot: makeChestnutRoot('/ws/.chestnut'),
    });

    expect(options.env?.[SENTINEL_ENV]).toBe('present');
    expect(options.env).not.toBe(process.env);
    expect(process.env.CHESTNUT_ROOT).not.toBe('/ws');
  });

  it('不同 identity/agentDir 输入产生对应 argv 与 logFile（单源协议、无调用方分叉）', () => {
    const a = createDaemonSpawnOptions({
      clawId: makeClawId('alpha'),
      agentDir: '/a',
      chestnutRoot: makeChestnutRoot('/w/.chestnut'),
    });
    const b = createDaemonSpawnOptions({
      clawId: makeClawId('beta'),
      agentDir: '/b',
      chestnutRoot: makeChestnutRoot('/w/.chestnut'),
    });

    expect(a.args[1]).toBe('alpha');
    expect(b.args[1]).toBe('beta');
    expect(a.logFile).toBe(path.join('/a', DAEMON_LOG));
    expect(b.logFile).toBe(path.join('/b', DAEMON_LOG));
    // 协议骨架一致：同一 entry、同一 command、同一 cwd 来源
    expect(a.args[0]).toBe(b.args[0]);
    expect(a.command).toBe(b.command);
    expect(a.cwd).toBe(b.cwd);
  });

  it('Phase 1926 Step C：expectedLLMIdentity 注入 env；缺省不带该键', () => {
    const withIdentity = createDaemonSpawnOptions({
      clawId: makeClawId('motion'),
      agentDir: '/ws/.chestnut/motion',
      chestnutRoot: makeChestnutRoot('/ws/.chestnut'),
      expectedLLMIdentity: 'abc123identity',
    });
    expect(withIdentity.env?.[EXPECTED_LLM_IDENTITY_ENV]).toBe('abc123identity');

    const without = createDaemonSpawnOptions({
      clawId: makeClawId('motion'),
      agentDir: '/ws/.chestnut/motion',
      chestnutRoot: makeChestnutRoot('/ws/.chestnut'),
    });
    expect(without.env?.[EXPECTED_LLM_IDENTITY_ENV]).toBeUndefined();
    expect(EXPECTED_LLM_IDENTITY_ENV in (without.env ?? {})).toBe(false);
  });
});
