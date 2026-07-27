/**
 * Phase 1201 Step D: contract progress authority ratchet.
 *
 * 固化 progress mutation 单 authority 架构（per-contract queue + durable outcome）：
 * 1. 旧内存闸门（VerificationMutex）在 src/tests 引用为 0；
 * 2. active progress production writer 只在 owner（manager.ts）与 persistence 定义处；
 * 3. verification cluster 无 `saveProgress(` 调用；
 * 4. queue enqueue key 只能是 contract ID；
 * 5. verifier 长计算不能位于 enqueue callback 内；
 * 6. background result 必须先 durable persist 再 apply；
 * 7. boot replay 文本顺序早于 in_progress reset。
 *
 * 每条 scanner 配反向 fixture：插入违规文本必须被检出。
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.join(__dirname, '..', '..', '..');
const srcRoot = path.join(repoRoot, 'src');
const contractSrc = path.join(srcRoot, 'core', 'contract');
const managerFile = path.join(contractSrc, 'manager.ts');
const verificationFile = path.join(contractSrc, 'verification.ts');

// ─── scanners（纯函数，可喂反向 fixture） ─────────────────────────────────────

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

/** 提取 `export async function <name>` 的函数体（先括号配对跳过参数列表，再 brace 配对）。 */
function extractFunctionBody(text: string, name: string): string | null {
  const sigIdx = text.indexOf(`export async function ${name}`);
  if (sigIdx === -1) return null;
  // 参数列表可含解构花括号：先对其外层的 `(...)` 配对，body 花括号在其后。
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

// ─── ratchet ─────────────────────────────────────────────────────────────────

describe('Phase 1201 Step D: contract progress authority ratchet', () => {
  it('规则 1：VerificationMutex 在 src/tests 引用为 0（本 scanner 文件除外）', () => {
    const cmd = `grep -rnE "VerificationMutex|verificationMutex|verification-mutex" ${srcRoot} ${path.join(repoRoot, 'tests')} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' }).trim();
    const selfFile = path.resolve(repoRoot, 'tests', 'foundation', 'arch', 'contract-progress-authority-ratchet.test.ts');
    const lines = out === '' ? [] : out.split('\n');
    const offenders = lines.filter(line => path.resolve(repoRoot, line.split(':')[0]) !== selfFile);
    expect(offenders).toEqual([]);
  });

  it('规则 1 反向 fixture：插入违规文本会被 scanner 检出', () => {
    const violating = 'const m = new VerificationMutex();\nctx.verificationMutex.release(a, b);';
    expect(findMutexReferences(violating)).toHaveLength(2);
    expect(findMutexReferences('const ok = 1;')).toHaveLength(0);
  });

  it('规则 2：active progress writer（saveProgress 调用）只在 manager.ts 与 persistence.ts', () => {
    const cmd = `grep -rnE "saveProgress\\(" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' }).trim();
    const lines = out === '' ? [] : out.split('\n');
    const allowed = new Set([
      path.join('src', 'core', 'contract', 'manager.ts'),
      path.join('src', 'core', 'contract', 'persistence.ts'),
    ].map(p => path.resolve(repoRoot, p)));
    const offenders = lines.filter(line => !allowed.has(path.resolve(repoRoot, line.split(':')[0])));
    expect(offenders).toEqual([]);
  });

  it('规则 3：verification cluster 无 saveProgress 调用', () => {
    const clusterFiles = fs.readdirSync(contractSrc)
      .filter(f => /^verification.*\.ts$|^verifier-job\.ts$/.test(f));
    expect(clusterFiles.length).toBeGreaterThan(0);
    for (const f of clusterFiles) {
      const text = fs.readFileSync(path.join(contractSrc, f), 'utf8');
      expect(findSaveProgressCalls(text), `${f} must not call saveProgress`).toEqual([]);
    }
  });

  it('规则 3 反向 fixture：cluster 内注入 saveProgress 调用会被检出', () => {
    expect(findSaveProgressCalls('await this.saveProgress(id, progress);')).toHaveLength(1);
    // 注释提及（无括号调用形式）不误报。
    expect(findSaveProgressCalls('// 不再 raw saveProgress。')).toHaveLength(0);
  });

  it('规则 4：`_enqueueProgressMutation(` 首参只能是 contractId', () => {
    const text = fs.readFileSync(managerFile, 'utf8');
    expect(findNonContractIdEnqueueKeys(text)).toEqual([]);
  });

  it('规则 4 反向 fixture：per-subtask key 会被检出', () => {
    const violating = 'await this._enqueueProgressMutation(\n  subtaskKey,\n  meta,\n  fn,\n);';
    expect(findNonContractIdEnqueueKeys(violating)).toHaveLength(1);
    const compliant = 'await this._enqueueProgressMutation(\n  contractId,\n  meta,\n  fn,\n);';
    expect(findNonContractIdEnqueueKeys(compliant)).toEqual([]);
  });

  it('规则 5：verifier 长计算不在 enqueue callback 内', () => {
    const text = fs.readFileSync(managerFile, 'utf8');
    expect(findVerifierExecInEnqueueCallbacks(text)).toEqual([]);
  });

  it('规则 5 反向 fixture：enqueue callback 内注入 verifier 执行会被检出', () => {
    const violating = [
      'await this._enqueueProgressMutation(',
      '  contractId,',
      '  meta,',
      '  async () => {',
      '    const r = await this.runScriptVerification(script, dir);',
      '    return r;',
      '  },',
      ');',
    ].join('\n');
    expect(findVerifierExecInEnqueueCallbacks(violating)).toHaveLength(1);
    const compliant = [
      'await this._enqueueProgressMutation(',
      '  contractId,',
      '  meta,',
      '  async () => { return this.saveProgress(contractId, p, dir); },',
      ');',
    ].join('\n');
    expect(findVerifierExecInEnqueueCallbacks(compliant)).toEqual([]);
  });

  it('规则 6：background result 先 durable persist 再 apply', () => {
    const text = fs.readFileSync(verificationFile, 'utf8');
    const body = extractFunctionBody(text, 'runVerificationInBackground');
    expect(body).not.toBeNull();
    expect(isPersistBeforeApply(body!)).toBe(true);
  });

  it('规则 6 反向 fixture：apply 先于 persist 会被检出', () => {
    const violating = 'async function bg() {\n  await applyVerificationOutcome(ctx);\n  await ctx.persistVerificationOutcome(o);\n}';
    expect(isPersistBeforeApply(violating)).toBe(false);
    const compliant = 'async function bg() {\n  await ctx.persistVerificationOutcome(o);\n  await applyVerificationOutcome(ctx);\n}';
    expect(isPersistBeforeApply(compliant)).toBe(true);
    // persist 缺失也算违规（fail-closed）。
    expect(isPersistBeforeApply('await applyVerificationOutcome(ctx);')).toBe(false);
  });

  it('规则 7：boot replay 文本顺序早于 in_progress reset', () => {
    const text = fs.readFileSync(managerFile, 'utf8');
    expect(isBootReplayBeforeReset(text)).toBe(true);
  });

  it('规则 7 反向 fixture：reset 先于 replay 会被检出', () => {
    const violating = "await reset({ kind: 'boot_reset' });\nawait this._replayVerificationOutcomes(contractId);";
    expect(isBootReplayBeforeReset(violating)).toBe(false);
    const compliant = "await this._replayVerificationOutcomes(contractId);\nawait reset({ kind: 'boot_reset' });";
    expect(isBootReplayBeforeReset(compliant)).toBe(true);
  });
});

// ─── Phase 1201 Step E 追加规则 ──────────────────────────────────────────────

const nodeFsFile = path.join(srcRoot, 'foundation', 'fs', 'node-fs.ts');
const persistenceFile = path.join(contractSrc, 'persistence.ts');
const verificationNotifyFile = path.join(contractSrc, 'verification-notify.ts');
const raceTestFile = path.join(repoRoot, 'tests', 'core', 'contract', 'progress-mutation-race.test.ts');

/** 规则 E1：文本中调用 ensure-parent 通用 writeAtomic（排除 writeAtomicExisting）。 */
export function findGenericWriteAtomicCalls(text: string): string[] {
  return text.split('\n').filter(line => /\.writeAtomic\(/.test(line));
}

/** 规则 E2：方法体内出现 ensureDir/mkdir。 */
export function findEnsureParentInBody(body: string): string[] {
  return body.split('\n').filter(line => /ensureDir|mkdir/.test(line));
}

/** 提取类方法体（`async <name>(` 起，先括号配对再 brace 配对）。 */
function extractMethodBody(text: string, name: string): string | null {
  const sigIdx = text.indexOf(`async ${name}(`);
  if (sigIdx === -1) return null;
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

/** 规则 E3/E4：persist 结果必须赋名且后跟含 conflict 分支的 switch。返回违规点。 */
export function findUnconsumedPersistResults(text: string): string[] {
  const violations: string[] = [];
  const callPattern = /await ctx\.persistVerificationOutcome\(/g;
  let m: RegExpExecArray | null;
  while ((m = callPattern.exec(text)) !== null) {
    // 必须形如 `const <name> = await ctx.persistVerificationOutcome(`
    const prefix = text.slice(Math.max(0, m.index - 80), m.index);
    const assignMatch = prefix.match(/const\s+(\w+)\s*=\s*$/);
    if (!assignMatch) {
      violations.push(`bare persist call @${m.index}`);
      continue;
    }
    const varName = assignMatch[1];
    // 后续 2000 字符内必须有 `switch (<varName>)` 且含 `case 'conflict'`。
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

describe('Phase 1201 Step E: progress commit correctness ratchet', () => {
  it('规则 E1：manager 不调用 ensure-parent 通用 writeAtomic；active 保存走 writeAtomicExisting', () => {
    const managerText = fs.readFileSync(managerFile, 'utf8');
    expect(findGenericWriteAtomicCalls(managerText)).toEqual([]);
    const body = extractFunctionBody(fs.readFileSync(persistenceFile, 'utf8'), 'saveActiveProgressExisting');
    expect(body).not.toBeNull();
    expect(body!).toContain('writeAtomicExisting(');
    expect(findGenericWriteAtomicCalls(body!)).toEqual([]);
  });

  it('规则 E1 反向 fixture：active owner 注入通用 writeAtomic 调用会被检出', () => {
    expect(findGenericWriteAtomicCalls('await this.fs.writeAtomic(p, c);')).toHaveLength(1);
    expect(findGenericWriteAtomicCalls('await this.fs.writeAtomicExisting(p, c);')).toHaveLength(0);
  });

  it('规则 E2：writeAtomicExisting 实现体不含 ensureDir/mkdir', () => {
    const body = extractMethodBody(fs.readFileSync(nodeFsFile, 'utf8'), 'writeAtomicExisting');
    expect(body).not.toBeNull();
    expect(findEnsureParentInBody(body!)).toEqual([]);
  });

  it('规则 E2 反向 fixture：实现体注入 ensureDir 会被检出', () => {
    expect(findEnsureParentInBody('{\n  await ensureDir(dir);\n  await writeAtomic(abs, c);\n}')).toHaveLength(1);
    expect(findEnsureParentInBody('{\n  return wrapENOENT(p, () => writeAtomic(abs, c));\n}')).toHaveLength(0);
  });

  it('规则 E3/E4：pass/reject/errored/interrupted persist 结果全部 exhaustive 消费且含 conflict 分支', () => {
    const verificationText = fs.readFileSync(verificationFile, 'utf8');
    const notifyText = fs.readFileSync(verificationNotifyFile, 'utf8');
    // 两个文件共有 ≥3 个 persist call site，全部合规。
    expect(findUnconsumedPersistResults(verificationText)).toEqual([]);
    expect(findUnconsumedPersistResults(notifyText)).toEqual([]);
  });

  it('规则 E3/E4 反向 fixture：裸 persist 调用或缺 conflict 分支会被检出', () => {
    const bare = 'async function f() {\n  await ctx.persistVerificationOutcome(o);\n}';
    expect(findUnconsumedPersistResults(bare)).toHaveLength(1);
    const noConflictBranch = [
      'const persistResult = await ctx.persistVerificationOutcome(o);',
      "switch (persistResult) { case 'persisted': break; }",
    ].join('\n');
    expect(findUnconsumedPersistResults(noConflictBranch)).toHaveLength(1);
    const compliant = [
      'const persistResult = await ctx.persistVerificationOutcome(o);',
      "switch (persistResult) { case 'persisted': case 'idempotent': break; case 'conflict': return; }",
    ].join('\n');
    expect(findUnconsumedPersistResults(compliant)).toEqual([]);
  });

  it('规则 E5：manager 无 public `_enqueueProgressMutation` 与 `progressMutationQueueDepth`', () => {
    const managerText = fs.readFileSync(managerFile, 'utf8');
    expect(findPublicQueueSurface(managerText)).toEqual([]);
  });

  it('规则 E5 反向 fixture：public delegate/depth 会被检出', () => {
    const violating = [
      '  async _enqueueProgressMutation<T>(',
      '  progressMutationQueueDepth(contractId: ContractId): number {',
    ].join('\n');
    expect(findPublicQueueSurface(violating)).toHaveLength(2);
    const compliant = '  private async _enqueueProgressMutation<T>(';
    expect(findPublicQueueSurface(compliant)).toEqual([]);
  });

  it('规则 E6：recheck-after/physical-write-before barrier race test 在固定 suite', () => {
    const raceText = fs.readFileSync(raceTestFile, 'utf8');
    // ghost race：writeAtomicExisting 入口 gate + gate 内 cancel rename + not_active 断言。
    expect(raceText).toContain('mutable.writeAtomicExisting');
    expect(raceText).toContain("expect(syncResult.kind).toBe('not_active')");
  });

  it('规则 E6 反向 fixture：无 barrier 标记文本不通过', () => {
    const noBarrier = "it('x', async () => { expect(1).toBe(1); });";
    expect(noBarrier).not.toContain('mutable.writeAtomicExisting');
  });
});
