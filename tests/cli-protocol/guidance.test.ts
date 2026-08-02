/**
 * Phase 1263 Step A: CLIProtocol typed guidance vocabulary + exhaustive renderer tests.
 *
 * 覆盖（计划 §4.4 测试矩阵）：
 * - 两种 target / 七种 action exact invocation string；
 * - 每个 label / subject exact presentation（与现存五个 CLI composer 逐字一致）；
 * - 多行顺序与两个 truncation subject 的 exact document output；
 * - 空 id / 空 contract id / 空 inactiveAfter、limit 0 / NaN / 非整数、非法
 *   truncation（负数 / shown > total / lines 数与 shown 冲突）均 fail-fast throw；
 * - 输入 document / lines / action 不被修改（纯函数）；
 * - compile-time fixture 用 satisfies / never 锁 union exhaustiveness（不用 cast）。
 */

import { describe, it, expect } from 'vitest';
import {
  renderCliGuidanceAction,
  renderCliGuidanceDocument,
  CliGuidanceRenderError,
  type CliGuidanceTarget,
  type CliGuidanceAction,
  type CliGuidanceLabel,
  type CliGuidanceSubject,
  type CliGuidanceDocument,
  type CliGuidanceDocumentLine,
} from '../../src/cli-protocol/index.js';

const clawA: CliGuidanceTarget = { kind: 'claw', id: 'clawA' };
const placeholder: CliGuidanceTarget = { kind: 'placeholder', name: 'claw-id' };

// compile-time fixture：satisfies 锁每个 union variant 都是合法成员（无 cast）。
const ALL_ACTIONS = [
  { kind: 'claw.daemon', target: clawA },
  { kind: 'claw.status', target: clawA },
  { kind: 'claw.steps', target: clawA },
  { kind: 'claw.watch', target: clawA, inactiveAfter: '5m' },
  { kind: 'claw.outbox', target: clawA, limit: 4 },
  { kind: 'claw.trace', clawId: 'clawA', contractId: 'c1' },
  { kind: 'contract.show', clawId: 'clawA', contractId: 'c1' },
] as const satisfies readonly CliGuidanceAction[];

const ALL_LABELS = [
  'restart',
  'inspect-before-crash',
  'check-current-status',
  'inspect-current-work',
  'inspect-stuck',
  'inspect',
  'watch-after-intervention',
  'read-outbox',
  'trace-contract',
  'show-contract',
] as const satisfies readonly CliGuidanceLabel[];

const ALL_SUBJECTS = [
  'contract-events',
  'contract-cancellations',
] as const satisfies readonly CliGuidanceSubject[];

// compile-time fixture：never 锁 exhaustiveness — union 增员时此处编译失败。
type AssertNever<T extends never> = T;
type _ActionKindExhaustive = AssertNever<Exclude<CliGuidanceAction['kind'], typeof ALL_ACTIONS[number]['kind']>>;
type _LabelExhaustive = AssertNever<Exclude<CliGuidanceLabel, typeof ALL_LABELS[number]>>;
type _SubjectExhaustive = AssertNever<Exclude<CliGuidanceSubject, typeof ALL_SUBJECTS[number]>>;

describe('phase 1263 Step A: renderCliGuidanceAction', () => {
  it('claw.daemon / status / steps 渲染裸 claw invocation（真 id 与 placeholder 两种 target）', () => {
    expect(renderCliGuidanceAction({ kind: 'claw.daemon', target: clawA }))
      .toBe('chestnut claw clawA daemon');
    expect(renderCliGuidanceAction({ kind: 'claw.status', target: clawA }))
      .toBe('chestnut claw clawA status');
    expect(renderCliGuidanceAction({ kind: 'claw.steps', target: clawA }))
      .toBe('chestnut claw clawA steps');
    expect(renderCliGuidanceAction({ kind: 'claw.steps', target: placeholder }))
      .toBe('chestnut claw <claw-id> steps');
  });

  it('claw.watch 追加 --inactive-after（保留 duration 原值）', () => {
    expect(renderCliGuidanceAction({ kind: 'claw.watch', target: clawA, inactiveAfter: '5m' }))
      .toBe('chestnut claw clawA watch --inactive-after 5m');
    expect(renderCliGuidanceAction({ kind: 'claw.watch', target: clawA, inactiveAfter: '30m' }))
      .toBe('chestnut claw clawA watch --inactive-after 30m');
  });

  it('claw.outbox 追加 --limit（placeholder 唯一渲染 <claw-id>、无双层尖括号）', () => {
    expect(renderCliGuidanceAction({ kind: 'claw.outbox', target: placeholder, limit: 4 }))
      .toBe('chestnut claw <claw-id> outbox --limit 4');
    expect(renderCliGuidanceAction({ kind: 'claw.outbox', target: clawA, limit: 25 }))
      .toBe('chestnut claw clawA outbox --limit 25');
  });

  it('claw.trace 渲染 subject-first trace + --contract', () => {
    expect(renderCliGuidanceAction({ kind: 'claw.trace', clawId: 'worker', contractId: 'c1' }))
      .toBe('chestnut claw worker trace --contract c1');
  });

  it('contract.show 渲染 verb-first show + -c / --contract', () => {
    expect(renderCliGuidanceAction({ kind: 'contract.show', clawId: 'worker', contractId: 'c1' }))
      .toBe('chestnut contract show -c worker --contract c1');
  });

  it('空真实 id / 空 inactiveAfter / 空 contract id → fail-fast throw（不静默默认）', () => {
    expect(() => renderCliGuidanceAction({ kind: 'claw.steps', target: { kind: 'claw', id: '' } }))
      .toThrowError(CliGuidanceRenderError);
    expect(() => renderCliGuidanceAction({ kind: 'claw.watch', target: clawA, inactiveAfter: '' }))
      .toThrowError(CliGuidanceRenderError);
    expect(() => renderCliGuidanceAction({ kind: 'claw.trace', clawId: '', contractId: 'c1' }))
      .toThrowError(CliGuidanceRenderError);
    expect(() => renderCliGuidanceAction({ kind: 'claw.trace', clawId: 'worker', contractId: '' }))
      .toThrowError(CliGuidanceRenderError);
    expect(() => renderCliGuidanceAction({ kind: 'contract.show', clawId: 'worker', contractId: '' }))
      .toThrowError(CliGuidanceRenderError);
  });

  it('limit 0 / 负数 / NaN / 非整数 → fail-fast throw（不 clamp、不默认）', () => {
    for (const limit of [0, -1, Number.NaN, 2.5, Number.POSITIVE_INFINITY]) {
      expect(() => renderCliGuidanceAction({ kind: 'claw.outbox', target: clawA, limit }))
        .toThrowError(CliGuidanceRenderError);
    }
  });
});

describe('phase 1263 Step A: renderCliGuidanceDocument label/subject presentation', () => {
  it('crash active_unexpected 两行 exact（restart + inspect-before-crash）', () => {
    const doc: CliGuidanceDocument = {
      lines: [
        { label: 'restart', action: { kind: 'claw.daemon', target: { kind: 'claw', id: 'claw-real' } } },
        { label: 'inspect-before-crash', action: { kind: 'claw.steps', target: { kind: 'claw', id: 'claw-real' } } },
      ],
    };
    expect(renderCliGuidanceDocument(doc)).toBe(
      'To restart: chestnut claw claw-real daemon\n' +
      'To inspect what the claw was doing before crash: chestnut claw claw-real steps',
    );
  });

  it('crash active_user_stopped 两行 exact（check-current-status + inspect-current-work）', () => {
    const doc: CliGuidanceDocument = {
      lines: [
        { label: 'check-current-status', action: { kind: 'claw.status', target: { kind: 'claw', id: 'claw-real' } } },
        { label: 'inspect-current-work', action: { kind: 'claw.steps', target: { kind: 'claw', id: 'claw-real' } } },
      ],
    };
    expect(renderCliGuidanceDocument(doc)).toBe(
      'To check current status: chestnut claw claw-real status\n' +
      'To inspect what the claw was doing: chestnut claw claw-real steps',
    );
  });

  it('inactivity inspect-stuck / inspect + watch-after-intervention exact', () => {
    const stuck: CliGuidanceDocument = {
      lines: [
        { label: 'inspect-stuck', action: { kind: 'claw.steps', target: clawA } },
        { label: 'watch-after-intervention', action: { kind: 'claw.watch', target: clawA, inactiveAfter: '5m' } },
      ],
    };
    expect(renderCliGuidanceDocument(stuck)).toBe(
      'To inspect what the agent is stuck on: chestnut claw clawA steps\n' +
      'To be notified if it remains stuck after intervention: chestnut claw clawA watch --inactive-after 5m',
    );
    const errored: CliGuidanceDocument = {
      lines: [
        { label: 'inspect', action: { kind: 'claw.steps', target: clawA } },
        { label: 'watch-after-intervention', action: { kind: 'claw.watch', target: clawA, inactiveAfter: '5m' } },
      ],
    };
    expect(renderCliGuidanceDocument(errored)).toBe(
      'To inspect: chestnut claw clawA steps\n' +
      'To be notified if it remains stuck after intervention: chestnut claw clawA watch --inactive-after 5m',
    );
  });

  it('outbox read-outbox label exact（中文 presentation + placeholder）', () => {
    const doc: CliGuidanceDocument = {
      lines: [
        { label: 'read-outbox', action: { kind: 'claw.outbox', target: placeholder, limit: 4 } },
      ],
    };
    expect(renderCliGuidanceDocument(doc)).toBe('查看具体内容： chestnut claw <claw-id> outbox --limit 4');
  });

  it('trace-contract / show-contract 裸 invocation 行（无 label 前缀、无 leading space）', () => {
    const doc: CliGuidanceDocument = {
      lines: [
        { label: 'trace-contract', action: { kind: 'claw.trace', clawId: 'motion', contractId: 'abc-123' } },
        { label: 'show-contract', action: { kind: 'contract.show', clawId: 'motion', contractId: 'abc-123' } },
      ],
    };
    expect(renderCliGuidanceDocument(doc)).toBe(
      'chestnut claw motion trace --contract abc-123\n' +
      'chestnut contract show -c motion --contract abc-123',
    );
  });

  it('truncation contract-events exact（提示行 + 空行 + lines、顺序保持）', () => {
    const lines: CliGuidanceDocumentLine[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(
        { label: 'trace-contract', action: { kind: 'claw.trace', clawId: `worker-${i}`, contractId: `c${i}` } },
        { label: 'show-contract', action: { kind: 'contract.show', clawId: `worker-${i}`, contractId: `c${i}` } },
      );
    }
    const text = renderCliGuidanceDocument({
      truncation: { total: 12, shown: 10, subject: 'contract-events' },
      lines,
    });
    expect(text.startsWith('(12 contract events、显示前 10)\n\nchestnut claw worker-0 trace --contract c0\n')).toBe(true);
    expect(text).toContain('chestnut contract show -c worker-9 --contract c9');
    expect(text).not.toContain('worker-10');
  });

  it('truncation contract-cancellations exact subject 字面', () => {
    const doc: CliGuidanceDocument = {
      truncation: { total: 12, shown: 1, subject: 'contract-cancellations' },
      lines: [
        { label: 'trace-contract', action: { kind: 'claw.trace', clawId: 'claw0', contractId: 'c0' } },
      ],
    };
    expect(renderCliGuidanceDocument(doc)).toBe(
      '(12 cancellations、显示前 1)\n\nchestnut claw claw0 trace --contract c0',
    );
  });

  it('空 lines + 无 truncation 合法 → 空字符串', () => {
    expect(renderCliGuidanceDocument({ lines: [] })).toBe('');
  });

  it('非法 truncation → fail-fast throw（负数 / shown > total / lines 数与 shown 冲突）', () => {
    const line: CliGuidanceDocumentLine = {
      label: 'trace-contract',
      action: { kind: 'claw.trace', clawId: 'claw0', contractId: 'c0' },
    };
    expect(() => renderCliGuidanceDocument({
      truncation: { total: -1, shown: 1, subject: 'contract-events' },
      lines: [line],
    })).toThrowError(CliGuidanceRenderError);
    expect(() => renderCliGuidanceDocument({
      truncation: { total: 12, shown: 0, subject: 'contract-events' },
      lines: [line],
    })).toThrowError(CliGuidanceRenderError);
    expect(() => renderCliGuidanceDocument({
      truncation: { total: 2, shown: 3, subject: 'contract-events' },
      lines: [line, line, line],
    })).toThrowError(CliGuidanceRenderError);
    expect(() => renderCliGuidanceDocument({
      truncation: { total: 12, shown: 2, subject: 'contract-events' },
      lines: [line],
    })).toThrowError(CliGuidanceRenderError);
    // truncation + 空 lines 非法（shown > 0 与 0 行冲突）
    expect(() => renderCliGuidanceDocument({
      truncation: { total: 12, shown: 10, subject: 'contract-events' },
      lines: [],
    })).toThrowError(CliGuidanceRenderError);
  });

  it('纯函数：输入 document / lines / action 不被修改', () => {
    const action: CliGuidanceAction = { kind: 'claw.outbox', target: placeholder, limit: 4 };
    const lines: readonly CliGuidanceDocumentLine[] = [{ label: 'read-outbox', action }];
    const truncation = { total: 5, shown: 1, subject: 'contract-events' } as const;
    const doc: CliGuidanceDocument = { lines, truncation };
    renderCliGuidanceDocument(doc);
    expect(action).toEqual({ kind: 'claw.outbox', target: placeholder, limit: 4 });
    expect(lines).toHaveLength(1);
    expect(doc.truncation).toBe(truncation);
    expect(doc.lines).toBe(lines);
  });
});
