/**
 * Phase 1324 Step B: Claw 命令族 direct tests 的窄 ClawCommandDeps fake。
 *
 * 每 test 调用一次构建 fresh 实例：vi.fn 计数不跨 test 泄漏
 * （vi.restoreAllMocks/clearAllMocks 不会把共享 fake 的实现洗掉后互相污染）。
 * fake Reader 默认 loadGlobal 计数桩、loadClaw 返回 valid minimal config
 * （仅用于存在性判定，不伪造完整业务配置）；missing/corrupt 由各 test 显式覆盖。
 */
import { vi } from 'vitest';
import type { RootConfigReader } from '../../src/assembly/index.js';
import type { ClawCommandDeps } from '../../src/cli/commands/claw-command-deps.js';

type LoadGlobal = RootConfigReader['loadGlobal'];
type LoadClaw = RootConfigReader['loadClaw'];

export interface FakeClawRootConfig {
  loadGlobal: ReturnType<typeof vi.fn<LoadGlobal>>;
  loadClaw: ReturnType<typeof vi.fn<LoadClaw>>;
}

export interface FakeClawCommandDeps extends ClawCommandDeps {
  rootConfig: FakeClawRootConfig;
}

export interface FakeClawRootConfigOptions {
  loadGlobal?: LoadGlobal;
  loadClaw?: LoadClaw;
}

/** Direct Claw command tests inject the owner-facing reader instead of mocking Assembly internals. */
export function makeClawCommandDeps(
  fsFactory: ClawCommandDeps['fsFactory'],
  options: FakeClawRootConfigOptions = {},
): FakeClawCommandDeps {
  return {
    fsFactory,
    rootConfig: {
      loadGlobal: vi.fn<LoadGlobal>(options.loadGlobal ?? (() => ({}) as ReturnType<LoadGlobal>)),
      loadClaw: vi.fn<LoadClaw>(options.loadClaw ?? (() => ({}) as NonNullable<ReturnType<LoadClaw>>)),
    },
  };
}
