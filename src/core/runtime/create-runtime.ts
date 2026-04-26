/**
 * createRuntime — Runtime 装配工厂
 *
 * 依据 identity 分支构造 ClawRuntime，把 motion/claw 身份判定收敛到
 * 工厂入口；调用方（Assembly）不再直接 new。
 *
 * 输入：ClawRuntimeOptions + identity 字段（intersection type）
 * 输出：ClawRuntime
 * 边界：identity='motion' 时 clawId 由调用方传 MOTION_CLAW_ID（工厂不覆盖）
 * 失败：构造期同步抛出 ClawRuntime 构造器抛出的任何错
 *
 * 见 design/modules/l5_runtime.md §2.1
 */

import { ClawRuntime, type ClawRuntimeOptions } from './runtime.js';
import type { ContextInjectorPort } from './runtime-ports.js';
import type { FileSystem } from '../../foundation/fs/types.js';

export type CreateRuntimeOptions = ClawRuntimeOptions & {
  identity: 'motion' | 'claw';
};

// 1:1 从 MotionRuntime.buildSystemPrompt() 提取（phase266 消除 MotionRuntime subclass）
async function buildMotionSystemPrompt({
  contextInjector,
  systemFs,
}: {
  contextInjector: ContextInjectorPort;
  systemFs: FileSystem;
}): Promise<string> {
  const parts = await contextInjector.buildParts();
  const sections: string[] = [];

  // 1. AGENTS.md
  if (parts.agents) {
    sections.push(parts.agents);
  }

  // 2. USER.md
  try {
    const user = (await systemFs.read('USER.md')).trim();
    if (user) sections.push(user);
  } catch { /* USER.md 不存在，跳过 */ }

  // 3. IDENTITY.md
  try {
    const identity = (await systemFs.read('IDENTITY.md')).trim();
    if (identity) sections.push(identity);
  } catch { /* 跳过 */ }

  // 4. SOUL.md
  try {
    const soul = (await systemFs.read('SOUL.md')).trim();
    if (soul) sections.push(soul);
  } catch { /* 跳过 */ }

  // 5. MEMORY.md
  if (parts.memory) {
    sections.push(parts.memory);
  }

  // 6. skills
  if (parts.skills) {
    sections.push(parts.skills);
  }

  // 7. contract
  if (parts.contract) {
    sections.push(parts.contract);
  }

  // 8. AUTH_POLICY.md
  try {
    const authPolicy = (await systemFs.read('AUTH_POLICY.md')).trim();
    if (authPolicy) sections.push(authPolicy);
  } catch { /* 跳过 */ }

  return sections.join('\n\n');
}

export { buildMotionSystemPrompt };

export function createRuntime(
  options: CreateRuntimeOptions
): ClawRuntime {
  const { identity, ...runtimeOptions } = options;
  if (identity === 'motion') {
    return new ClawRuntime({
      ...runtimeOptions,
      systemPromptBuilder: buildMotionSystemPrompt,
      identityToolFilter: (registry) => registry.unregister('send'),
    });
  }
  return new ClawRuntime(runtimeOptions);
}
