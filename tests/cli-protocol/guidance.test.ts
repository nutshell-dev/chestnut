/**
 * Phase 1263 Step A: CLIProtocol typed guidance vocabulary + exhaustive renderer tests.
 *
 * 覆盖（计划 §4.4 测试矩阵）：
 * - 两种 target / 六种 action exact invocation string；
 * - 每个 label / subject exact presentation（与现存五个 CLI composer 逐字一致）；
 * - 多行顺序与两个 truncation subject 的 exact document output；
 * - 空 id / 空 contract id、limit 0 / NaN / 非整数、非法
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
  type CliGuidanceInput,
  type CliGuidanceBinding,
  defineCliGuidanceBinding,
  registerCliGuidance,
  createCliSafeToken,
} from '../../src/cli-protocol/index.js';

const clawA: CliGuidanceTarget = { kind: 'claw', id: 'clawA' };
const placeholder: CliGuidanceTarget = { kind: 'placeholder', name: 'claw-id' };

// compile-time fixture：satisfies 锁每个 union variant 都是合法成员（无 cast）。
const ALL_ACTIONS = [
  { kind: 'claw.daemon', target: clawA },
  { kind: 'claw.status', target: clawA },
  { kind: 'claw.steps', target: clawA },
  { kind: 'claw.outbox', target: clawA, limit: 4 },
  // phase 1754 Step B：重复 outbox summary 的逐 claw skip 指引（scope 恒 --all）
  { kind: 'claw.outbox-skip', target: clawA },
  { kind: 'claw.trace', clawId: createCliSafeToken('clawA'), contractId: createCliSafeToken('c1') },
  { kind: 'contract.show', clawId: createCliSafeToken('clawA'), contractId: createCliSafeToken('c1') },
] as const satisfies readonly CliGuidanceAction[];

const ALL_LABELS = [
  'restart',
  'inspect-before-crash',
  'check-current-status',
  'inspect-current-work',
  'inspect-stuck',
  'inspect',
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

// phase 1877 Step D（cli-protocol-label-action-cartesian 收口）：非法 label/action
// 组合编译期拒绝（@ts-expect-error 锁类型穷尽）；合法组合由下方渲染用例全数保留。
const ILLEGAL_LINE_FIXTURES = [
  // @ts-expect-error restart 只合法配对 claw.daemon
  { label: 'restart', action: { kind: 'contract.show', clawId: createCliSafeToken('clawA'), contractId: createCliSafeToken('c1') } },
  // @ts-expect-error show-contract 只合法配对 contract.show
  { label: 'show-contract', action: { kind: 'claw.daemon', target: clawA } },
  // @ts-expect-error trace-contract 不合法配对 claw.status
  { label: 'trace-contract', action: { kind: 'claw.status', target: clawA } },
  // @ts-expect-error read-outbox 不合法配对 claw.trace（无 target/clawId 形状交叉）
  { label: 'read-outbox', action: { kind: 'claw.trace', clawId: createCliSafeToken('clawA'), contractId: createCliSafeToken('c1') } },
] as const satisfies readonly CliGuidanceDocumentLine[];
void ILLEGAL_LINE_FIXTURES;

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

  it('claw.outbox 追加 --limit（placeholder 唯一渲染 <claw-id>、无双层尖括号）', () => {
    expect(renderCliGuidanceAction({ kind: 'claw.outbox', target: placeholder, limit: 4 }))
      .toBe('chestnut claw <claw-id> outbox --limit 4');
    expect(renderCliGuidanceAction({ kind: 'claw.outbox', target: clawA, limit: 25 }))
      .toBe('chestnut claw clawA outbox --limit 25');
  });

  it('phase 1754 Step B: claw.outbox-skip 渲染 outbox-skip --all（真 id 与 placeholder 两种 target）', () => {
    expect(renderCliGuidanceAction({ kind: 'claw.outbox-skip', target: clawA }))
      .toBe('chestnut claw clawA outbox-skip --all');
    expect(renderCliGuidanceAction({ kind: 'claw.outbox-skip', target: placeholder }))
      .toBe('chestnut claw <claw-id> outbox-skip --all');
  });

  it('phase 1754 Step B: claw target id 含空白字符 → fail-fast throw（owner-safe token 校验）', () => {
    for (const id of ['claw A', 'claw\tA', 'claw\nA']) {
      expect(() => renderCliGuidanceAction({ kind: 'claw.outbox-skip', target: { kind: 'claw', id } }))
        .toThrowError(CliGuidanceRenderError);
    }
  });

  it('claw.trace 渲染 subject-first trace + --contract', () => {
    expect(renderCliGuidanceAction({ kind: 'claw.trace', clawId: createCliSafeToken('worker'), contractId: createCliSafeToken('c1') }))
      .toBe('chestnut claw worker trace --contract c1');
  });

  it('contract.show 渲染 verb-first show + -c / --contract', () => {
    expect(renderCliGuidanceAction({ kind: 'contract.show', clawId: createCliSafeToken('worker'), contractId: createCliSafeToken('c1') }))
      .toBe('chestnut contract show -c worker --contract c1');
  });

  it('空真实 id → fail-fast throw（不静默默认）', () => {
    expect(() => renderCliGuidanceAction({ kind: 'claw.steps', target: { kind: 'claw', id: '' } }))
      .toThrowError(CliGuidanceRenderError);
  });

  it('phase 1796: 空 / 非法 token 在 factory 构造期 fail-fast（renderer 只接受 CliSafeToken brand）', () => {
    expect(() => createCliSafeToken('')).toThrowError(CliGuidanceRenderError);
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

  it('inspect-stuck / inspect exact（不再附加 watch action）', () => {
    const stuck: CliGuidanceDocument = {
      lines: [
        { label: 'inspect-stuck', action: { kind: 'claw.steps', target: clawA } },
      ],
    };
    expect(renderCliGuidanceDocument(stuck)).toBe(
      'To inspect what the agent is stuck on: chestnut claw clawA steps',
    );
    const errored: CliGuidanceDocument = {
      lines: [
        { label: 'inspect', action: { kind: 'claw.steps', target: clawA } },
      ],
    };
    expect(renderCliGuidanceDocument(errored)).toBe(
      'To inspect: chestnut claw clawA steps',
    );
  });

  it('outbox read-outbox label exact（phase 1834: 读取并消费用途说明 + placeholder）', () => {
    const doc: CliGuidanceDocument = {
      lines: [
        { label: 'read-outbox', action: { kind: 'claw.outbox', target: placeholder, limit: 4 } },
      ],
    };
    expect(renderCliGuidanceDocument(doc)).toBe('读取并消费（最多 --limit 指定的条数）：chestnut claw <claw-id> outbox --limit 4');
  });

  it('trace-contract / show-contract 查询用途标签前缀（phase 1832）', () => {
    const doc: CliGuidanceDocument = {
      lines: [
        { label: 'trace-contract', action: { kind: 'claw.trace', clawId: createCliSafeToken('motion'), contractId: createCliSafeToken('abc-123') } },
        { label: 'show-contract', action: { kind: 'contract.show', clawId: createCliSafeToken('motion'), contractId: createCliSafeToken('abc-123') } },
      ],
    };
    expect(renderCliGuidanceDocument(doc)).toBe(
      '查看相关执行记录： chestnut claw motion trace --contract abc-123\n' +
      '查看契约与进度摘要： chestnut contract show -c motion --contract abc-123',
    );
  });

  it('truncation contract-events exact（提示行 + 空行 + lines、顺序保持）', () => {
    const lines: CliGuidanceDocumentLine[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(
        { label: 'trace-contract', action: { kind: 'claw.trace', clawId: createCliSafeToken(`worker-${i}`), contractId: createCliSafeToken(`c${i}`) } },
        { label: 'show-contract', action: { kind: 'contract.show', clawId: createCliSafeToken(`worker-${i}`), contractId: createCliSafeToken(`c${i}`) } },
      );
    }
    const text = renderCliGuidanceDocument({
      truncation: { total: 12, shown: 10, subject: 'contract-events' },
      lines,
    });
    expect(text.startsWith('(12 contract events、显示前 10)\n\n查看相关执行记录： chestnut claw worker-0 trace --contract c0\n')).toBe(true);
    expect(text).toContain('查看契约与进度摘要： chestnut contract show -c worker-9 --contract c9');
    expect(text).not.toContain('worker-10');
  });

  it('truncation contract-cancellations exact subject 字面', () => {
    const doc: CliGuidanceDocument = {
      truncation: { total: 12, shown: 1, subject: 'contract-cancellations' },
      lines: [
        { label: 'trace-contract', action: { kind: 'claw.trace', clawId: createCliSafeToken('claw0'), contractId: createCliSafeToken('c0') } },
      ],
    };
    expect(renderCliGuidanceDocument(doc)).toBe(
      '(12 cancellations、显示前 1)\n\n查看相关执行记录： chestnut claw claw0 trace --contract c0',
    );
  });

  it('空 lines + 无 truncation 合法 → 空字符串', () => {
    expect(renderCliGuidanceDocument({ lines: [] })).toBe('');
  });

  it('非法 truncation → fail-fast throw（负数 / shown > total / lines 数与 shown 冲突）', () => {
    const line: CliGuidanceDocumentLine = {
      label: 'trace-contract',
      action: { kind: 'claw.trace', clawId: createCliSafeToken('claw0'), contractId: createCliSafeToken('c0') },
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


/**
 * Phase 1263 Step B: generic-correlated binding + 最小 registrar + 注册 helper tests.
 *
 * 覆盖（计划 §4.4 测试矩阵）：
 * - fake state 字段被 adapter 以具体类型消费，`@ts-expect-error` 锁错配；
 * - single / multiple binding 注册 type 与顺序；
 * - input identity 传给 decoder；document 渲成 entry；null 保持 null；
 * - decoder、adapter、renderer throw 均原样暴露；
 * - duplicate type 在调用 registrar 前 throw；空 bindings 零注册；
 * - registrar 结构兼容（fake object 直传，不 import / instantiate Assembly registry）。
 */

interface FakeState {
  readonly clawId: string;
  readonly count: number;
}

function fakeInput(type = 'fake_type', from = 'fake-from'): CliGuidanceInput {
  return { type, from, meta: { k: 'v' } };
}

/** fake registrar：记录调用序 + 按 type 取 composer（结构兼容断言、非 Assembly 实现）。 */
function createFakeRegistrar() {
  const calls: string[] = [];
  const composers = new Map<string, (input: CliGuidanceInput) => { text: string } | null>();
  const registrar: CliGuidanceRegistrar = {
    register(type, composer) {
      calls.push(type);
      composers.set(type, composer);
    },
    has(type) {
      return composers.has(type);
    },
  };
  return { registrar, calls, composers };
}

describe('phase 1263 Step B: defineCliGuidanceBinding generic correlation', () => {
  it('decoder state 与 adapter 参数类型相关：字段以具体类型消费、错配编译失败', () => {
    const binding = defineCliGuidanceBinding({
      type: 'fake_typed',
      decode: () => ({ clawId: 'clawA', count: 42 }),
      toDocument: (state) => {
        // State 从对象字面推断（无显式宽泛 annotation）：具体类型消费
        const id: string = state.clawId;
        const n: number = state.count;
        void id; void n;
        // @ts-expect-error count 是 number、不是 string
        const bad: string = state.count;
        void bad;
        // @ts-expect-error decode 不产出 missing 字段
        void state.missing;
        return null;
      },
    });
    expect(binding.type).toBe('fake_typed');
    expect(binding.toDocument(binding.decode(fakeInput()))).toBeNull();
  });

  it('factory 原样返回 binding、不包装修饰', () => {
    const literal = {
      type: 'fake_identity',
      decode: () => ({ clawId: 'clawA', count: 1 }),
      toDocument: () => null,
    };
    expect(defineCliGuidanceBinding(literal)).toBe(literal);
  });
});

describe('phase 1263 Step B: registerCliGuidance', () => {
  function fakeBinding(overrides?: {
    toDocument?: (state: FakeState) => CliGuidanceDocument | null;
  }): CliGuidanceBinding<FakeState> {
    return defineCliGuidanceBinding({
      type: 'fake_type',
      decode: (input) => ({ clawId: input.from, count: 1 }),
      toDocument: overrides?.toDocument ?? ((state) => ({
        lines: [
          { label: 'inspect-current-work', action: { kind: 'claw.steps', target: { kind: 'claw', id: state.clawId } } },
        ],
      })),
    });
  }

  it('single binding：注册 type、input identity 传给 decoder、document 渲成 entry', () => {
    const { registrar, calls, composers } = createFakeRegistrar();
    const seen: CliGuidanceInput[] = [];
    const binding = defineCliGuidanceBinding({
      type: 'fake_type',
      decode: (input) => {
        seen.push(input);
        return { clawId: input.from, count: 1 };
      },
      toDocument: (state) => ({
        lines: [
          { label: 'inspect-current-work', action: { kind: 'claw.steps', target: { kind: 'claw', id: state.clawId } } },
        ],
      }),
    });
    registerCliGuidance(registrar, [binding]);
    expect(calls).toEqual(['fake_type']);

    const input = fakeInput('fake_type', 'claw-real');
    const entry = composers.get('fake_type')!(input);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(input); // identity：不重建对象
    expect(entry).toEqual({ text: 'To inspect what the claw was doing: chestnut claw claw-real steps' });
  });

  it('multiple bindings：按给定顺序注册、各自独立 compose', () => {
    const { registrar, calls, composers } = createFakeRegistrar();
    const a = defineCliGuidanceBinding({
      type: 'fake_a',
      decode: () => ({ clawId: 'clawA', count: 1 }),
      toDocument: (state) => ({
        lines: [{ label: 'inspect-current-work', action: { kind: 'claw.steps', target: { kind: 'claw', id: state.clawId } } }],
      }),
    });
    const b = defineCliGuidanceBinding({
      type: 'fake_b',
      decode: () => ({ clawId: 'clawB', count: 2 }),
      toDocument: (state) => ({
        lines: [{ label: 'read-outbox', action: { kind: 'claw.outbox', target: { kind: 'claw', id: state.clawId }, limit: state.count } }],
      }),
    });
    registerCliGuidance(registrar, [a, b]);
    expect(calls).toEqual(['fake_a', 'fake_b']);
    expect(composers.get('fake_a')!(fakeInput('fake_a')))
      .toEqual({ text: 'To inspect what the claw was doing: chestnut claw clawA steps' });
    expect(composers.get('fake_b')!(fakeInput('fake_b')))
      .toEqual({ text: '读取并消费（最多 --limit 指定的条数）：chestnut claw clawB outbox --limit 2' });
  });

  it('toDocument null = 合法显式无 affordance → composer 返 null（不经 renderer）', () => {
    const { registrar, composers } = createFakeRegistrar();
    registerCliGuidance(registrar, [fakeBinding({ toDocument: () => null })]);
    expect(composers.get('fake_type')!(fakeInput())).toBeNull();
  });

  it('decoder throw 原样传播（不 catch、不包装成 null）', () => {
    const { registrar, composers } = createFakeRegistrar();
    const failure = new Error('owner decode failure');
    const binding = defineCliGuidanceBinding({
      type: 'fake_type',
      decode: (): FakeState => { throw failure; },
      toDocument: () => null,
    });
    registerCliGuidance(registrar, [binding]);
    expect(() => composers.get('fake_type')!(fakeInput())).toThrowError(failure);
  });

  it('adapter throw 原样暴露', () => {
    const { registrar, composers } = createFakeRegistrar();
    const failure = new Error('adapter failure');
    registerCliGuidance(registrar, [fakeBinding({
      toDocument: () => { throw failure; },
    })]);
    expect(() => composers.get('fake_type')!(fakeInput())).toThrowError(failure);
  });

  it('renderer throw 原样暴露（非法 document 不被吞）', () => {
    const { registrar, composers } = createFakeRegistrar();
    registerCliGuidance(registrar, [fakeBinding({
      toDocument: () => ({
        lines: [{ label: 'read-outbox', action: { kind: 'claw.outbox', target: { kind: 'claw', id: 'clawA' }, limit: 0 } }],
      }),
    })]);
    expect(() => composers.get('fake_type')!(fakeInput())).toThrowError(CliGuidanceRenderError);
  });

  it('duplicate type 在调用 registrar 前 fail-fast（preflight 完整扫描、零注册）', () => {
    const { registrar, calls } = createFakeRegistrar();
    const first = fakeBinding();
    const second = defineCliGuidanceBinding({
      type: 'fake_type',
      decode: () => ({ clawId: 'clawB', count: 1 }),
      toDocument: () => null,
    });
    const third = defineCliGuidanceBinding({
      type: 'fake_other',
      decode: () => ({ clawId: 'clawC', count: 1 }),
      toDocument: () => null,
    });
    expect(() => registerCliGuidance(registrar, [first, second, third]))
      .toThrowError(/duplicate cli guidance binding type: fake_type/);
    expect(calls).toEqual([]); // 不能注册一半才发现冲突
  });

  it('phase 1877 Step E: 跨批重复 type（registrar 已有注册）→ preflight fail-fast、整批零注册', () => {
    const { registrar, calls } = createFakeRegistrar();
    registerCliGuidance(registrar, [fakeBinding()]);
    expect(calls).toEqual(['fake_type']);
    const dup = defineCliGuidanceBinding({
      type: 'fake_type',
      decode: () => ({ clawId: 'clawB', count: 1 }),
      toDocument: () => null,
    });
    const fresh = defineCliGuidanceBinding({
      type: 'fake_fresh',
      decode: () => ({ clawId: 'clawC', count: 1 }),
      toDocument: () => null,
    });
    expect(() => registerCliGuidance(registrar, [dup, fresh]))
      .toThrowError(/cli guidance binding type already registered: fake_type/);
    expect(calls).toEqual(['fake_type']); // 整批无部分提交
  });

  it('空 bindings 合法 no-op（零注册）', () => {
    const { registrar, calls } = createFakeRegistrar();
    registerCliGuidance(registrar, []);
    expect(calls).toEqual([]);
  });
});
