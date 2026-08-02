/**
 * Phase 1264 Step B: cli-guidance-boundary.test.ts 的共享扫描原语。
 * Phase 1265 Step A: `exhaustive` 改 optional — 仅 owner state 带 discriminated
 * business union 的 case 配置，无 union 的纯映射 case 不伪造穷尽检查。
 * Phase 1266 Step A: case interface + data 拆至 cli-guidance-boundary-cases.ts
 * （随 binding 数量线性增长的纯配置独立成文件），本文件 re-export 现有名字
 * 保持 test 单一入口，只保留 scanner helpers。
 *
 * 只为同目录单一 architecture invariant 服务：提供路径常量与 scanner helpers；
 * 验收决策（expect/assertion）全部留在 .test.ts，本文件不含任何测试语义或生产
 * 语义。srcRoot 保持 file-private，只暴露 test 消费的推导结果。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { type CliGuidanceBindingBoundaryCase } from './cli-guidance-boundary-cases.js';

export { CLI_GUIDANCE_BINDINGS, type CliGuidanceBindingBoundaryCase } from './cli-guidance-boundary-cases.js';

const srcRoot = path.join(__dirname, '..', '..', '..', 'src');

export const CLI_PROTOCOL_DIR = path.join(srcRoot, 'cli-protocol');
export const COMPOSERS_INDEX = path.join(srcRoot, 'assembly', 'guidance', 'composers', 'index.ts');

/**
 * import/export ... from 语句的 module specifier（含 mixed 与 type-only 形态）。
 * global flag：只供 matchAll 使用，禁止以 .test() 复用（lastIndex 漂移）。
 */
export const IMPORT_SPECIFIER_RE = /(?:import|export)\s+(?:type\s+)?(?:[\w*{][^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;

/** typed binding 禁含：自由 entry 字段 / CLI literal / prose / renderer 调用 / 无关 owner state 字段。 */
export function bindingForbiddenRe(binding: CliGuidanceBindingBoundaryCase): RegExp {
  const parts = [
    'text:',
    'chestnut',
    binding.prose,
    'renderClawInvocation',
    'renderCliGuidance',
    'CONTRACT_COMMANDS',
    ...binding.forbiddenFields,
  ];
  return new RegExp(parts.join('|'));
}

/** 旧 composer import specifier 识别（composers/<name> 深链或同目录 ./<name> shim）。 */
export function oldComposerSpecifierRe(file: string): RegExp {
  const basename = file.replace(/\.ts$/, '');
  return new RegExp(`composers/${basename}|^\\./${basename}`);
}

export function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

export function bindingPath(file: string): string {
  return path.join(srcRoot, 'assembly', 'guidance', 'bindings', file);
}

export function oldComposerPath(file: string): string {
  return path.join(srcRoot, 'assembly', 'guidance', 'composers', file);
}

export function assemblyDir(): string {
  return path.join(srcRoot, 'assembly');
}

/** violation 消息展示用的 src 相对路径。 */
export function relativeToSrc(file: string): string {
  return path.relative(srcRoot, file);
}
