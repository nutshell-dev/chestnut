/**
 * Phase 1201 Step D/E: boot ordering + race barrier suite ratchet.
 *
 * 单一职责：boot 确定性顺序与竞态回归套件。
 * - boot replay durable outcomes 文本顺序早于 in_progress reset；
 * - recheck-after/physical-write-before barrier race test 在固定 suite。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import {
  RATCHET_PATHS,
  isBootReplayBeforeReset,
} from '../../helpers/progress-authority-scanners.js';

const { managerFile, raceTestFile } = RATCHET_PATHS;

describe('Phase 1201: boot ordering ratchet', () => {
  it('规则 7：boot replay 文本顺序早于 in_progress reset', () => {
    const text = fs.readFileSync(managerFile, 'utf8');
    expect(isBootReplayBeforeReset(text)).toBe(true);
  });

  it('规则 7 反向 fixture：reset 先于 replay / replay 缺失会被检出', () => {
    const violating = "await reset({ kind: 'boot_reset' });\nawait this._replayVerificationOutcomes(contractId);";
    expect(isBootReplayBeforeReset(violating)).toBe(false);
    const compliant = "await this._replayVerificationOutcomes(contractId);\nawait reset({ kind: 'boot_reset' });";
    expect(isBootReplayBeforeReset(compliant)).toBe(true);
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
