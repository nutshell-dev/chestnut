/**
 * @module L6.CLIProtocol.Guidance
 *
 * Phase 1263 Step A 立：typed CLI guidance vocabulary + exhaustive pure renderer。
 *
 * 应然（Phase 1255 冻结 / Phase 1263 总览）：
 * - CLIProtocol 独占 CLI action vocabulary、label/subject 自然语言 presentation 与
 *   最终 invocation/layout；Assembly binding 只产 typed document，不再产 prose、
 *   CLI literal 或最终 `GuidanceEntry`（M#1/M#2）。
 * - `CliGuidanceAction` 七种 variant 一次冻结五个现存 CLI binding 的全部需求
 *   （M#7：public surface 不随外部模块逐个迁入而增长）。
 * - renderer 纯函数、exhaustive switch：新 union variant 未处理必须编译失败（M#9）；
 *   非法值（空 id / 空 contract id / 非正整数 limit / 空 inactiveAfter / 非法
 *   truncation）fail-fast throw，不得静默默认或 clamp（信息不丢失）。
 * - label/subject presentation map 是 CLIProtocol 内部 layout 知识，不导出 ——
 *   Assembly 只能经 document renderer 得最终文本，不能绕过 document 自行拼行。
 *
 * 本文件不 import Runtime、Assembly 或任一 owner（M#5/M#6：CLIProtocol 零实现依赖）。
 * truncation 只表达 presentation 事实（total/shown/subject），不截断或复制 owner state。
 *
 * Phase 1263 Step B 立：generic-correlated binding + 最小 registrar + 注册 helper。
 * - `CliGuidanceInput` / `CliGuidanceRegistrar` 是最小结构协议：CLIProtocol 不 import
 *   Runtime `GuidanceEnvelope` 或 Assembly `GuidanceEntry`，也不持 registry handle
 *   （M#8： registrar 只暴露 register，无 compose/get/map/unregister）。
 * - `defineCliGuidanceBinding<State>` 保持 owner decoded state 与 adapter 的 generic
 *   相关性（禁 unknown/any/cast）；CLIProtocol 不解释 state、不列举任何消息 type。
 * - `registerCliGuidance` 发起 decode→adapt→render→register；duplicate type 在调
 *   registrar 前完整 preflight fail-fast（不能注册一半才发现冲突）；decoder/adapter/
 *   renderer error 原样传播（不 catch、不包装成 null，Runtime 现有 audit 边界处理）。
 */

import { renderClawInvocation, CONTRACT_COMMANDS } from './invocation.js';

/** CLI invocation 的 claw 目标：真实 claw id 或 motion 自填占位符，discriminated union。 */
export type CliGuidanceTarget =
  | { readonly kind: 'claw'; readonly id: string }
  | { readonly kind: 'placeholder'; readonly name: 'claw-id' };

/** 冻结的 CLI guidance action vocabulary（Phase 1255 冻结七种 variant；
 * Phase 1396 Step H 退役 claw.watch；Phase 1754 Step B 增第八种 claw.outbox-skip —
 * 重复 outbox summary 的逐 claw skip 指引，scope 恒为 `--all`、无其它 scope variant）。 */
export type CliGuidanceAction =
  | { readonly kind: 'claw.daemon'; readonly target: CliGuidanceTarget }
  | { readonly kind: 'claw.status'; readonly target: CliGuidanceTarget }
  | { readonly kind: 'claw.steps'; readonly target: CliGuidanceTarget }
  | { readonly kind: 'claw.outbox'; readonly target: CliGuidanceTarget; readonly limit: number }
  | { readonly kind: 'claw.outbox-skip'; readonly target: CliGuidanceTarget }
  | { readonly kind: 'claw.trace'; readonly clawId: CliSafeToken; readonly contractId: CliSafeToken }
  | { readonly kind: 'contract.show'; readonly clawId: CliSafeToken; readonly contractId: CliSafeToken };

/**
 * closed label union — 语义 presentation role，不取 owner variant 名
 * （否则 CLIProtocol 被迫认识业务模块）。
 */
export type CliGuidanceLabel =
  | 'restart'
  | 'inspect-before-crash'
  | 'check-current-status'
  | 'inspect-current-work'
  | 'inspect-stuck'
  | 'inspect'
  | 'read-outbox'
  | 'trace-contract'
  | 'show-contract';

/** closed truncation subject union — 超 cap 提示行的事实主语。 */
export type CliGuidanceSubject = 'contract-events' | 'contract-cancellations';

export interface CliGuidanceDocumentLine {
  readonly label: CliGuidanceLabel;
  readonly action: CliGuidanceAction;
}

/** presentation 截断事实：total/shown/subject，不复制 owner 项。 */
export interface CliGuidanceTruncation {
  readonly total: number;
  readonly shown: number;
  readonly subject: CliGuidanceSubject;
}

/**
 * Assembly binding 产出的唯一装配协议形状：closed label + typed action 行，
 * 可选 typed truncation。不含自由 text、CLI literal 或 owner 无关字段（M#8）。
 */
export interface CliGuidanceDocument {
  readonly lines: readonly CliGuidanceDocumentLine[];
  readonly truncation?: CliGuidanceTruncation;
}

/**
 * label → presentation prefix（含 trailing 分隔、空串 = 无 label 裸 invocation 行）。
 * 精确保留现存五个 CLI composer 的英文/中文文案；file-private，不导出。
 */
const LABEL_PREFIX: Record<CliGuidanceLabel, string> = {
  restart: 'To restart: ',
  'inspect-before-crash': 'To inspect what the claw was doing before crash: ',
  'check-current-status': 'To check current status: ',
  'inspect-current-work': 'To inspect what the claw was doing: ',
  'inspect-stuck': 'To inspect what the agent is stuck on: ',
  inspect: 'To inspect: ',
  'read-outbox': '查看具体内容： ',
  // phase 1832: 查询用途标签——trace 是相关执行记录（不保证每条仅归属该契约），
  // show 是契约与进度摘要（evidence 预览截断 300 字）；同一查询入口用途说明，
  // 完成/取消通知共用，不改变业务或 refs 数量。
  'trace-contract': '查看相关执行记录： ',
  'show-contract': '查看契约与进度摘要： ',
};

/** subject → presentation 字面（超 cap 提示行）。file-private，不导出。 */
const SUBJECT_TEXT: Record<CliGuidanceSubject, string> = {
  'contract-events': 'contract events',
  'contract-cancellations': 'cancellations',
};

/** renderer fail-fast 唯一错误类型（非法 typed 输入、不含 owner wire 失败）。 */
export class CliGuidanceRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliGuidanceRenderError';
  }
}

/**
 * phase 1796: CLI-safe token brand + factory（cli-protocol-guidance-token-undervalidated）。
 * 单行 invocation operand token 的构造期校验：空 / 空白 / 控制字符 / 前导 `-`
 * （option-like，会被 CLI parser 误读为 flag）fail-fast；renderer 只接受 brand、
 * 不再接受裸 string（不复制业务 identity 规则——业务 id charset 归 owner codec，
 * 本 brand 只守 CLI 单行安全）。
 */
declare const cliSafeTokenBrand: unique symbol;
export type CliSafeToken = string & { readonly [cliSafeTokenBrand]: true };

const CLI_SAFE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function createCliSafeToken(raw: string): CliSafeToken {
  if (!CLI_SAFE_TOKEN_RE.test(raw)) {
    throw new CliGuidanceRenderError(
      `cli guidance token must be CLI-safe (alnum start, [A-Za-z0-9._-]*), got ${JSON.stringify(raw)}`,
    );
  }
  return raw as CliSafeToken;
}

function requireNonEmptyId(value: string, what: string): string {
  if (value.length === 0) {
    throw new CliGuidanceRenderError(`cli guidance ${what} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value: number, what: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliGuidanceRenderError(`cli guidance ${what} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

/**
 * target → invocation operand；placeholder 唯一渲染成 `<claw-id>`。
 * 真实 claw id 是 owner-safe token 校验（phase 1754 Step B）：空 / 含空白字符
 * （空格 / tab / 换行）fail-fast — 空白会使单行 invocation 产生歧义、可能被
 * shell 拆成多个参数；占位符渲染不受此校验影响。
 */
function renderCliGuidanceTarget(target: CliGuidanceTarget): string {
  switch (target.kind) {
    case 'claw': {
      const id = requireNonEmptyId(target.id, 'claw target id');
      if (/\s/.test(id)) {
        throw new CliGuidanceRenderError('cli guidance claw target id must not contain whitespace');
      }
      return id;
    }
    case 'placeholder':
      return `<${target.name}>`;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

/**
 * typed action → 完整 CLI invocation。exhaustive switch：
 * 新 action variant 未处理时编译失败（M#9）。
 */
export function renderCliGuidanceAction(action: CliGuidanceAction): string {
  switch (action.kind) {
    case 'claw.daemon':
      return renderClawInvocation(renderCliGuidanceTarget(action.target), 'daemon');
    case 'claw.status':
      return renderClawInvocation(renderCliGuidanceTarget(action.target), 'status');
    case 'claw.steps':
      return renderClawInvocation(renderCliGuidanceTarget(action.target), 'steps');
    case 'claw.outbox':
      return `${renderClawInvocation(renderCliGuidanceTarget(action.target), 'outbox')} --limit ${requirePositiveInteger(action.limit, 'outbox limit')}`;
    case 'claw.outbox-skip':
      // phase 1754 Step B：scope 恒 --all（variant 名即冻结该语义、无 limit variant）。
      return `${renderClawInvocation(renderCliGuidanceTarget(action.target), 'outbox-skip')} --all`;
    case 'claw.trace':
      // phase 1796: clawId/contractId 是 CliSafeToken brand（构造期已校验），renderer 不再重验裸 string
      return `${renderClawInvocation(action.clawId, 'trace')} --contract ${action.contractId}`;
    case 'contract.show':
      return `${CONTRACT_COMMANDS.SHOW} -c ${action.clawId} --contract ${action.contractId}`;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function validateTruncation(truncation: CliGuidanceTruncation, lineCount: number): void {
  requirePositiveInteger(truncation.total, 'truncation total');
  requirePositiveInteger(truncation.shown, 'truncation shown');
  if (truncation.shown > truncation.total) {
    throw new CliGuidanceRenderError(
      `cli guidance truncation shown (${truncation.shown}) must not exceed total (${truncation.total})`,
    );
  }
  if (lineCount < truncation.shown) {
    throw new CliGuidanceRenderError(
      `cli guidance truncation shown (${truncation.shown}) conflicts with rendered line count (${lineCount})`,
    );
  }
}

/**
 * typed document → 最终 guidance 文本。先验证 document，再按当前 layout 输出：
 * 可选 truncation 提示行 + 空行，随后 `<label prefix><invocation>` 行，`\n` 连接。
 * 空 lines 仅在无 truncation 时合法并渲染空字符串；不替业务 adapter 决定是否返回 null。
 * 纯函数：不修改输入 document/lines/action。
 */
export function renderCliGuidanceDocument(document: CliGuidanceDocument): string {
  if (document.truncation !== undefined) {
    validateTruncation(document.truncation, document.lines.length);
  }
  const parts: string[] = [];
  if (document.truncation !== undefined) {
    const t = document.truncation;
    parts.push(`(${t.total} ${SUBJECT_TEXT[t.subject]}、显示前 ${t.shown})`, '');
  }
  for (const line of document.lines) {
    parts.push(`${LABEL_PREFIX[line.label]}${renderCliGuidanceAction(line.action)}`);
  }
  return parts.join('\n');
}

/**
 * 最小结构化输入 — 与 Runtime envelope `{ type, from, meta }` 结构兼容，
 * 但 CLIProtocol 不向下 import Runtime（M#5/M#6）。
 */
export interface CliGuidanceInput {
  readonly type: string;
  readonly from: string;
  readonly meta: Readonly<Record<string, string>>;
}

/**
 * 最小 registrar port — Assembly registry 的结构适配面。只暴露 register；
 * CLIProtocol 不接管 registry resource、不认识 generic guidance / NO_GUIDANCE。
 */
export interface CliGuidanceRegistrar {
  register(
    type: string,
    composer: (input: CliGuidanceInput) => { text: string } | null,
  ): void;
}

/**
 * owner decoded state → typed document 的 cross-protocol binding。
 * decode/toDocument 用 method 签名声明：heterogeneous binding 数组经
 * `CliGuidanceBinding<unknown>` 受控擦除时由方法 bivariance 放行，
 * 而单个 factory 调用内 State 的相关性仍由 generic 推断锁定（M#9）。
 */
export interface CliGuidanceBinding<State> {
  readonly type: string;
  decode(input: CliGuidanceInput): State;
  toDocument(state: State): CliGuidanceDocument | null;
}

/**
 * binding factory：保留 `State` 推断（decode 返回与 toDocument 参数类型相关），
 * 禁止 `unknown`/`any`/cast 掩盖错配。CLIProtocol 不解释 state。
 */
export function defineCliGuidanceBinding<State>(
  binding: CliGuidanceBinding<State>,
): CliGuidanceBinding<State> {
  return binding;
}

/**
 * CLIProtocol 发起的注册控制流：对每个 binding 注册闭包
 * `input → decode（throw 原样传播）→ toDocument（null = 合法显式无 affordance）
 * → renderCliGuidanceDocument → { text }`。
 *
 * duplicate type 在调用 registrar 前完整 preflight fail-fast（避免 registrar 的
 * last-win 静默覆盖 / 注册一半才发现冲突）；bindings 顺序不改变；空列表合法 no-op。
 * 不 catch decoder/adapter/renderer error — Runtime 现有 audit 边界处理。
 */
export function registerCliGuidance(
  registrar: CliGuidanceRegistrar,
  bindings: readonly CliGuidanceBinding<unknown>[],
): void {
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (seen.has(binding.type)) {
      throw new CliGuidanceRenderError(`duplicate cli guidance binding type: ${binding.type}`);
    }
    seen.add(binding.type);
  }
  for (const binding of bindings) {
    registrar.register(binding.type, (input) => {
      const state = binding.decode(input);
      const document = binding.toDocument(state);
      if (document === null) return null;
      return { text: renderCliGuidanceDocument(document) };
    });
  }
}
