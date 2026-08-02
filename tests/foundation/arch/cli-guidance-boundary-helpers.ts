/**
 * Phase 1264 Step B: cli-guidance-boundary.test.ts 的共享数据/扫描原语。
 * Phase 1265 Step A: 新增第三个 case（claw_outbox_summary）；`exhaustive` 改
 * optional — 仅 owner state 带 discriminated business union 的 case 配置，无 union
 * 的纯映射 case 不伪造穷尽检查。
 *
 * 只为同目录单一 architecture invariant 服务：提供 binding case 配置、路径常量
 * 与 scanner helpers；验收决策（expect/assertion）全部留在 .test.ts，本文件不含
 * 任何测试语义或生产语义。srcRoot 保持 file-private，只暴露 test 消费的推导结果。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const srcRoot = path.join(__dirname, '..', '..', '..', 'src');

/**
 * 已迁 typed binding 的边界 case（逐 case 明确 owner codec / prose / forbidden
 * fields，禁止宽化成「任意 Watchdog import」）。
 * prose：该 binding 旧 composer 曾产的 presentation 前缀字面（迁后必消失）；
 * forbiddenFields：不参与 CLI affordance 的 owner state 字段（不得跨边界消费），
 * 使用带 `state.` 的精确 token（避免 owner import 路径/注释普通单词误报）。
 */
export interface CliGuidanceBindingBoundaryCase {
  readonly file: string;
  readonly type: string;
  readonly ident: string;
  readonly decoder: string;
  /** owner state 的 discriminated union 字段；无业务 union 的 case 省略（不伪造 switch）。 */
  readonly exhaustive?: string;
  readonly ownerCodec: string;
  readonly prose: string;
  readonly forbiddenFields: readonly string[];
}

export const CLI_GUIDANCE_BINDINGS: readonly CliGuidanceBindingBoundaryCase[] = [
  {
    file: 'claw-crashed.ts',
    type: 'claw_crashed',
    ident: 'clawCrashedGuidanceBinding',
    decoder: 'decodeClawCrashedGuidance',
    exhaustive: 'crashClass',
    ownerCodec: '../../../watchdog/claw-crashed-guidance.js',
    prose: 'To restart',
    forbiddenFields: [],
  },
  {
    file: 'claw-inactivity.ts',
    type: 'claw_inactivity',
    ident: 'clawInactivityGuidanceBinding',
    decoder: 'decodeClawInactivityGuidance',
    exhaustive: 'failureClass',
    ownerCodec: '../../../watchdog/claw-inactivity-guidance.js',
    prose: 'To inspect',
    forbiddenFields: ['inactiveMs', 'sourcePath', 'lastError'],
  },
  {
    file: 'claw-outbox-summary.ts',
    type: 'claw_outbox_summary',
    ident: 'clawOutboxSummaryGuidanceBinding',
    decoder: 'decodeOutboxSummaryGuidance',
    ownerCodec: '../../../core/claw-topology/jobs/outbox-summary/guidance-state.js',
    prose: '查看具体内容',
    forbiddenFields: ['state.hash', 'state.counts', 'state.totalClaws'],
  },
];

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
