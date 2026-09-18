/**
 * Phase 1201 Step D/E: progress mutation queue authority ratchet.
 *
 * 单一职责：queue 是 progress mutation 唯一调度 authority。
 * - 旧内存闸门（VerificationMutex）在 src/tests 引用为 0；
 * - enqueue key 只能是 contract ID；
 * - verifier 长计算不能位于 enqueue callback 内；
 * - manager 无 public arbitrary callback enqueue / queue depth surface。
 *
 * scanner 在 tests/helpers/progress-authority-scanners.ts；每条带反向 fixture。
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RATCHET_PATHS,
  findMutexReferences,
  findNonContractIdEnqueueKeys,
  findVerifierExecInEnqueueCallbacks,
  findPublicQueueSurface,
  findUntypedMutationSurface,
} from '../../helpers/progress-authority-scanners.js';

const { repoRoot, srcRoot, managerFile, queueFile, scannerHelperFile } = RATCHET_PATHS;

describe('Phase 1201: progress queue authority ratchet', () => {
  it('规则 1：VerificationMutex 在 src/tests 引用为 0（scanner/本文件除外）', () => {
    const cmd = `grep -rnE "VerificationMutex|verificationMutex|verification-mutex" ${srcRoot} ${path.join(repoRoot, 'tests')} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' }).trim();
    const selfFile = path.resolve(repoRoot, 'tests', 'foundation', 'arch', 'contract-progress-authority-ratchet.test.ts');
    const lines = out === '' ? [] : out.split('\n');
    const allowed = new Set([selfFile, scannerHelperFile]);
    const offenders = lines.filter(line => !allowed.has(path.resolve(repoRoot, line.split(':')[0])));
    expect(offenders).toEqual([]);
  });

  it('规则 1 反向 fixture：插入违规文本会被 scanner 检出', () => {
    const violating = 'const m = new VerificationMutex();\nctx.verificationMutex.release(a, b);';
    expect(findMutexReferences(violating)).toHaveLength(2);
    expect(findMutexReferences('const ok = 1;')).toHaveLength(0);
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
      '  async () => { return this.saveActiveProgressExisting(contractId, p); },',
      ');',
    ].join('\n');
    expect(findVerifierExecInEnqueueCallbacks(compliant)).toEqual([]);
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
    expect(findPublicQueueSurface('  private async _enqueueProgressMutation<T>(')).toEqual([]);
  });

  it('规则 7（phase 1862 Step F / CT-D7）：manager 不得直调 queue.enqueue；queue 不得回退 arbitrary-T 面', () => {
    const managerText = fs.readFileSync(managerFile, 'utf8');
    const queueText = fs.readFileSync(queueFile, 'utf8');
    expect(findUntypedMutationSurface(managerText, queueText)).toEqual([]);
  });

  it('规则 7 反向 fixture：delegate 外直调 enqueue / 泛型 enqueue<T> 会被检出', () => {
    const managerWithExtraDirect = [
      'class M {',
      '  private async _enqueueProgressMutation<K extends ProgressMutationKind>(',
      '    contractId: ContractId,',
      '    meta: ProgressMutationMeta<K>,',
      '    mutation: () => Promise<ProgressMutationResultMap[K]>,',
      '  ): Promise<ProgressMutationResultMap[K]> {',
      '    return this.progressMutationQueue.enqueue(contractId, meta, mutation);',
      '  }',
      '  async bypass(contractId: ContractId, meta: ProgressMutationMeta, fn: () => Promise<unknown>) {',
      '    return this.progressMutationQueue.enqueue(contractId, meta, fn);',
      '  }',
      '}',
    ].join('\n');
    const violating = findUntypedMutationSurface(
      managerWithExtraDirect,
      '  async enqueue<T>(\n    contractId: ContractId,',
    );
    expect(violating).toHaveLength(2);
    const compliantManager = managerWithExtraDirect.split('\n').filter(
      line => !line.includes('bypass') && !line.includes('meta, fn'),
    ).join('\n');
    expect(findUntypedMutationSurface(compliantManager, '  async enqueue<K extends ProgressMutationKind>(')).toEqual([]);
  });
});
