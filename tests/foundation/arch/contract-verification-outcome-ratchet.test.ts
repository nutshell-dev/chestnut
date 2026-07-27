/**
 * Phase 1201 Step D/E: durable verification outcome ordering ratchet.
 *
 * 单一职责：verifier 结果必须 durable-first，且 persist 结果被 exhaustive
 * 消费（conflict fail-closed）。
 * - background result 先 durable persist 再 apply（文本顺序）；
 * - 每个 persist call site 结果赋名 + switch 含 conflict 分支。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import {
  RATCHET_PATHS,
  isPersistBeforeApply,
  findUnconsumedPersistResults,
  extractFunctionBody,
} from '../../helpers/progress-authority-scanners.js';

const { verificationFile, verificationNotifyFile } = RATCHET_PATHS;

describe('Phase 1201: verification outcome durable-first ratchet', () => {
  it('规则 6：background result 先 durable persist 再 apply', () => {
    const text = fs.readFileSync(verificationFile, 'utf8');
    const body = extractFunctionBody(text, 'runVerificationInBackground');
    expect(body).not.toBeNull();
    expect(isPersistBeforeApply(body!)).toBe(true);
  });

  it('规则 6 反向 fixture：apply 先于 persist / persist 缺失会被检出', () => {
    const violating = 'async function bg() {\n  await applyVerificationOutcome(ctx);\n  await ctx.persistVerificationOutcome(o);\n}';
    expect(isPersistBeforeApply(violating)).toBe(false);
    const compliant = 'async function bg() {\n  await ctx.persistVerificationOutcome(o);\n  await applyVerificationOutcome(ctx);\n}';
    expect(isPersistBeforeApply(compliant)).toBe(true);
    // persist 缺失也算违规（fail-closed）。
    expect(isPersistBeforeApply('await applyVerificationOutcome(ctx);')).toBe(false);
  });

  it('规则 E3/E4：persist 结果全部 exhaustive 消费且含 conflict 分支', () => {
    const verificationText = fs.readFileSync(verificationFile, 'utf8');
    const notifyText = fs.readFileSync(verificationNotifyFile, 'utf8');
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
});
