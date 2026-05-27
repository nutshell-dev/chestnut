/**
 * createRuntime — Runtime 装配工厂
 *
 * 依据 identity 分支构造 Runtime，把 motion/claw 身份判定收敛到
 * 工厂入口；调用方（Assembly）不再直接 new。
 *
 * 输入：RuntimeOptions + identity 字段（intersection type）
 * 输出：Runtime
 * 边界：identity='motion' 时 clawId 由调用方传 MOTION_CLAW_ID（工厂不覆盖）
 * 失败：构造期同步抛出 Runtime 构造器抛出的任何错
 *
 * 见 design/modules/l5_runtime.md §2.1
 */

import { Runtime } from './runtime.js';
import { MOTION_CLAW_ID } from '../../constants.js';
import type { RuntimeOptions } from './types.js';
import type { ContextInjector } from '../dialog/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { RUNTIME_AUDIT_EVENTS } from './runtime-audit-events.js';

export type CreateRuntimeOptions = RuntimeOptions & {
  identity: 'motion' | 'claw';
};

async function tryReadOptionalSection(
  systemFs: FileSystem,
  filePath: string,
  audit: AuditLog | undefined,
): Promise<string | undefined> {
  try {
    const content = (await systemFs.read(filePath)).trim();
    return content || undefined;
  } catch (err) {
    const errCode = (err as { code?: string }).code;
    if (errCode === 'ENOENT' || errCode === 'FS_NOT_FOUND') return undefined; // silent skip 合规
    audit?.write(
      RUNTIME_AUDIT_EVENTS.OPTIONAL_SECTION_READ_FAILED,
      `path=${filePath}`,
      `reason=${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

export { tryReadOptionalSection };

// 1:1 从 MotionRuntime.buildSystemPrompt() 提取（phase266 消除 MotionRuntime subclass）
async function buildMotionSystemPrompt({
  contextInjector,
  systemFs,
  audit,
}: {
  contextInjector: ContextInjector;
  systemFs: FileSystem;
  audit?: AuditLog;
}): Promise<string> {
  const parts = await contextInjector.buildParts();
  const sections: string[] = [];

  // 1. AGENTS.md
  if (parts.agents) {
    sections.push(parts.agents);
  }

  // 2. USER.md
  const user = await tryReadOptionalSection(systemFs, 'USER.md', audit);
  if (user) sections.push(user);

  // 3. IDENTITY.md
  const identity = await tryReadOptionalSection(systemFs, 'IDENTITY.md', audit);
  if (identity) sections.push(identity);

  // 4. SOUL.md
  const soul = await tryReadOptionalSection(systemFs, 'SOUL.md', audit);
  if (soul) sections.push(soul);

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
  const authPolicy = await tryReadOptionalSection(systemFs, 'AUTH_POLICY.md', audit);
  if (authPolicy) sections.push(authPolicy);

  return sections.join('\n\n');
}

export { buildMotionSystemPrompt };

export function createRuntime(
  options: CreateRuntimeOptions
): Runtime {
  const { identity, ...runtimeOptions } = options;
  if (identity === MOTION_CLAW_ID) {
    return new Runtime({
      ...runtimeOptions,
      systemPromptBuilder: buildMotionSystemPrompt,
      identityToolFilter: (registry) => registry.unregister('send'),
    });
  }
  return new Runtime(runtimeOptions);
}
