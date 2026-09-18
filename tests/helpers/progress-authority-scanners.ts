/**
 * Phase 1201 Step D/E: contract progress authority ratchet scanners（纯函数）。
 *
 * 拆自 tests/foundation/arch/contract-progress-authority-ratchet.test.ts
 * （arch test 单文件 ≤150 行约束）。每个 scanner 接受文本、返回违规列表，
 * 由 arch test 喂 production 源码与反向 fixture。
 */
import * as path from 'node:path';

const repoRoot = path.join(__dirname, '..', '..');
const srcRoot = path.join(repoRoot, 'src');
const contractSrc = path.join(srcRoot, 'core', 'contract');

/** ratchet 扫描常用路径。 */
export const RATCHET_PATHS = {
  repoRoot,
  srcRoot,
  contractSrc,
  managerFile: path.join(contractSrc, 'manager.ts'),
  queueFile: path.join(contractSrc, 'progress-mutation-queue.ts'),
  verificationFile: path.join(contractSrc, 'verification.ts'),
  persistenceFile: path.join(contractSrc, 'persistence.ts'),
  verificationNotifyFile: path.join(contractSrc, 'verification-notify.ts'),
  nodeFsFile: path.join(srcRoot, 'foundation', 'fs', 'node-fs.ts'),
  raceTestFile: path.join(repoRoot, 'tests', 'core', 'contract', 'progress-mutation-race.test.ts'),
  scannerHelperFile: path.join(repoRoot, 'tests', 'helpers', 'progress-authority-scanners.ts'),
} as const;

/** 规则 1：旧内存闸门引用。返回违规行。 */
export function findMutexReferences(text: string): string[] {
  const pattern = /VerificationMutex|verificationMutex|verification-mutex/;
  return text.split('\n').filter(line => pattern.test(line));
}

/** 规则 3：文本中的 `saveProgress(` 调用行（注释不含括号形式，天然豁免）。 */
export function findSaveProgressCalls(text: string): string[] {
  return text.split('\n').filter(line => /saveProgress\(/.test(line));
}

/** 规则 4：`_enqueueProgressMutation(` 调用首参必须是 `contractId`。返回违规调用片段。 */
export function findNonContractIdEnqueueKeys(text: string): string[] {
  const violations: string[] = [];
  const pattern = /_enqueueProgressMutation\(\s*([A-Za-z0-9_.$]+)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m[1] !== 'contractId') violations.push(m[0]);
  }
  return violations;
}

/** 从 `startIdx`（`(` 的位置）起做括号配对，返回含首尾括号的子串。 */
function extractParenBody(text: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return text.slice(openIdx);
}

const VERIFIER_EXEC_NAMES = [
  'runVerificationByType',
  'runScriptVerification',
  'runLLMVerification',
  'runContractVerifier',
  'runVerifierWithCancel',
];

/** 规则 5：enqueue callback 内不得出现 verifier 长计算执行函数。返回违规描述。 */
export function findVerifierExecInEnqueueCallbacks(text: string): string[] {
  const violations: string[] = [];
  const pattern = /_enqueueProgressMutation\(/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const body = extractParenBody(text, m.index + m[0].length - 1);
    for (const name of VERIFIER_EXEC_NAMES) {
      if (body.includes(name)) violations.push(`${name} inside enqueue callback @${m.index}`);
    }
  }
  return violations;
}

/** 规则 6：函数体内 persist 必须先于 apply。返回 true = 合规。 */
export function isPersistBeforeApply(fnBody: string): boolean {
  const persistIdx = fnBody.indexOf('persistVerificationOutcome(');
  const applyIdx = fnBody.indexOf('applyVerificationOutcome(');
  if (persistIdx === -1 || applyIdx === -1) return false;
  return persistIdx < applyIdx;
}

/**
 * 规则 7（phase 1862 Step F / CT-D7）：typed per-kind FIFO mutation 协议锁。
 * - manager 不得绕过 private delegate 直接调 `progressMutationQueue.enqueue(`；
 * - queue 不得回退 arbitrary-T 泛型回调面（`enqueue<T>`）。
 */
export function findUntypedMutationSurface(managerText: string, queueText: string): string[] {
  const violations: string[] = [];
  // private delegate 本体是唯一允许直调点：将其方法体剔除后再扫。
  // 注意签名含泛型 `<K extends …>`，不能用 `async name(` 定位。
  const delegateBody = extractDelegateBody(managerText);
  const outsideDelegate = delegateBody.length > 0 ? managerText.replace(delegateBody, '') : managerText;
  for (const line of outsideDelegate.split('\n')) {
    if (/progressMutationQueue\.enqueue\(/.test(line)) violations.push(`manager direct enqueue: ${line.trim()}`);
  }
  for (const line of queueText.split('\n')) {
    if (/enqueue\s*<\s*T\s*>/.test(line)) violations.push(`queue arbitrary-T enqueue: ${line.trim()}`);
  }
  return violations;
}

/** 提取 `_enqueueProgressMutation` 方法体（容忍泛型签名），找不到返回 ''。 */
function extractDelegateBody(text: string): string {
  const sigIdx = text.indexOf('async _enqueueProgressMutation');
  if (sigIdx === -1) return '';
  const braceIdx = text.indexOf('{', sigIdx);
  if (braceIdx === -1) return '';
  let depth = 0;
  for (let i = braceIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(braceIdx, i + 1);
    }
  }
  return '';
}

/** 提取 `export async function <name>` 的函数体（先括号配对跳过参数列表，再 brace 配对）。 */
export function extractFunctionBody(text: string, name: string): string | null {
  const sigIdx = text.indexOf(`export async function ${name}`);
  if (sigIdx === -1) return null;
  const body = extractFromParamsClose(text, sigIdx);
  return body;
}

/** 提取类方法体（`async <name>(` 起，同样跳过参数列表）。 */
export function extractMethodBody(text: string, name: string): string | null {
  const sigIdx = text.indexOf(`async ${name}(`);
  if (sigIdx === -1) return null;
  return extractFromParamsClose(text, sigIdx);
}

function extractFromParamsClose(text: string, sigIdx: number): string | null {
  const paramsOpen = text.indexOf('(', sigIdx);
  let pDepth = 0;
  let paramsClose = -1;
  for (let i = paramsOpen; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') pDepth++;
    else if (ch === ')') {
      pDepth--;
      if (pDepth === 0) { paramsClose = i; break; }
    }
  }
  if (paramsClose === -1) return null;
  const openIdx = text.indexOf('{', paramsClose);
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return null;
}

/** 规则 7：boot 源码内 replay 调用必须先于 reset mutation。返回 true = 合规。 */
export function isBootReplayBeforeReset(initText: string): boolean {
  const replayIdx = initText.indexOf('await this._replayVerificationOutcomes(contractId)');
  const resetIdx = initText.indexOf("kind: 'boot_reset'");
  if (replayIdx === -1 || resetIdx === -1) return false;
  return replayIdx < resetIdx;
}

/** 规则 E1：文本中调用 ensure-parent 通用 writeAtomic（排除 writeAtomicExisting）。 */
export function findGenericWriteAtomicCalls(text: string): string[] {
  return text.split('\n').filter(line => /\.writeAtomic\(/.test(line));
}

/** 规则 E2：方法体内出现 ensureDir/mkdir。 */
export function findEnsureParentInBody(body: string): string[] {
  return body.split('\n').filter(line => /ensureDir|mkdir/.test(line));
}

/** 规则 E3/E4：persist 结果必须赋名且后跟含 conflict 分支的 switch。返回违规点。 */
export function findUnconsumedPersistResults(text: string): string[] {
  const violations: string[] = [];
  const callPattern = /await ctx\.persistVerificationOutcome\(/g;
  let m: RegExpExecArray | null;
  while ((m = callPattern.exec(text)) !== null) {
    const prefix = text.slice(Math.max(0, m.index - 80), m.index);
    const assignMatch = prefix.match(/const\s+(\w+)\s*=\s*$/);
    if (!assignMatch) {
      violations.push(`bare persist call @${m.index}`);
      continue;
    }
    const varName = assignMatch[1];
    const following = text.slice(m.index, m.index + 2000);
    const switchIdx = following.indexOf(`switch (${varName})`);
    if (switchIdx === -1 || !following.slice(switchIdx).includes("case 'conflict'")) {
      violations.push(`persist result '${varName}' without exhaustive conflict branch @${m.index}`);
    }
  }
  return violations;
}

/** 规则 E5：manager 暴露 public enqueue delegate 或 depth surface。返回违规行。 */
export function findPublicQueueSurface(text: string): string[] {
  const violations: string[] = [];
  for (const line of text.split('\n')) {
    if (/^\s*async _enqueueProgressMutation/.test(line)) violations.push(line.trim());
    if (/progressMutationQueueDepth/.test(line)) violations.push(line.trim());
  }
  return violations;
}
