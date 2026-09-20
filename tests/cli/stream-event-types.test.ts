/**
 * CLI 汇总完整性测试（phase 1321 分层拆件）。
 *
 * - CliStreamEventType 值集合 = 4 个 const 并集（56 = 46 协议层 + 6 agent + 3 task + 1 assembly）
 * - 上层 10 与协议层 46 无交集
 * - CliStreamEventType 与并集类型级一致（编译期断言）
 */

import { describe, expect, it } from 'vitest';
import { STREAM_EVENT_NAMES } from '../../src/foundation/stream/index.js';
// phase 1789: CLI 经本地 wire catalog 汇总、不导入业务 owner；parity 由本文件断言守护
import { SUBAGENT_EVENTS } from '../../src/core/subagent/index.js';
import { STREAM_TASK_EVENTS } from '../../src/core/async-task-system/index.js';
import { ASSEMBLY_STREAM_EVENTS } from '../../src/assembly/stream-events.js';
import { STREAM_WIRE_EVENTS, type CliStreamEventType } from '../../src/viewport/stream-event-types.js';

type Assert<T extends true> = T;
type UpperEventType =
  | (typeof STREAM_WIRE_EVENTS)[number]
  | (typeof STREAM_TASK_EVENTS)[keyof typeof STREAM_TASK_EVENTS]
  | (typeof ASSEMBLY_STREAM_EVENTS)[keyof typeof ASSEMBLY_STREAM_EVENTS];
// 类型级互检：上层 10 与协议层 46 无交集；CliStreamEventType 覆盖协议层与上层
type _NoOverlap = Assert<UpperEventType extends (typeof STREAM_EVENT_NAMES)[keyof typeof STREAM_EVENT_NAMES] ? false : true>;
type _CliCoversProtocol = Assert<(typeof STREAM_EVENT_NAMES)[keyof typeof STREAM_EVENT_NAMES] extends CliStreamEventType ? true : false>;
type _CliCoversUpper = Assert<UpperEventType extends CliStreamEventType ? true : false>;

const protocolValues = Object.values(STREAM_EVENT_NAMES) as string[];
const agentValues = [...STREAM_WIRE_EVENTS] as string[];
const taskValues = Object.values(STREAM_TASK_EVENTS) as string[];
const assemblyValues = Object.values(ASSEMBLY_STREAM_EVENTS) as string[];

describe('CLI stream event 汇总', () => {
  it('4 个 const 并集值集合 == 56（46 协议层 + 6 agent + 3 task + 1 assembly）', () => {
    const allValues = [...protocolValues, ...agentValues, ...taskValues, ...assemblyValues];
    expect(new Set(allValues).size).toBe(56);
  });

  it('上层 const 与协议层无交集（值级）', () => {
    expect(agentValues.every(v => !protocolValues.includes(v))).toBe(true);
    expect(taskValues.every(v => !protocolValues.includes(v))).toBe(true);
    expect(assemblyValues.every(v => !protocolValues.includes(v))).toBe(true);
  });

  it('上层 const 成员数基线（agent 6 / task 3 / assembly 1）', () => {
    expect(agentValues.length).toBe(6);
    expect(taskValues.length).toBe(3);
    expect(assemblyValues.length).toBe(1);
  });

  it('phase 1789: wire catalog 与语义 owner SUBAGENT_EVENTS 值集合一致（drift 守护）', () => {
    const ownerValues = Object.values(SUBAGENT_EVENTS) as string[];
    expect(new Set(agentValues)).toEqual(new Set(ownerValues));
  });
});
