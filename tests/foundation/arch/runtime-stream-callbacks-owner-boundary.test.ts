import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

/**
 * phase 1504 原锁「agent-executor 为 StreamCallbacks 协议 owner」于 phase 1856
 * (AE-D5) 重判为反向锁：StreamCallbacks 跨层语义回归 invoke owner ——
 * AgentExecutor 只 own 其循环实际触发的 stream 段；turn 生命周期归
 * Runtime（onTurnEnd/onTurnError/onTurnInterrupted）与 EventLoop（onTurnStart）；
 * provider 生命周期归 Runtime。consumer 组合最小 sink，禁止整包 dumping type。
 */
describe('StreamCallbacks owner boundary (phase 1504 → phase 1856 AE-D5 反向锁)', () => {
  it('AgentExecutor-owned StreamCallbacks 只含其循环实际触发的 stream 段', () => {
    const source = read('src/core/agent-executor/stream-callbacks.ts');
    const body = source.match(/export interface StreamCallbacks \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;
    expect(body).toBeDefined();
    expect(body).not.toMatch(/^\s*onTurn(Start|End|Error|Interrupted)\?/m);
    expect(body).not.toMatch(/^\s*onProvider(Info|Failover|Failed)\?/m);
    // 收缩后恰为 8 个 stream 段字段
    expect(body?.match(/^\s*on[A-Z][A-Za-z]+\?/gm)).toHaveLength(8);
    // barrel 仍导出收缩后的 stream 协议（AgentExecutor 唯一对外流协议面）
    expect(read('src/core/agent-executor/index.ts')).toMatch(
      /export type \{ StreamCallbacks \} from '\.\/stream-callbacks\.js';/,
    );
  });

  it('Runtime 自持 turn/provider 生命周期回调类型并消费最小组合 sink', () => {
    const source = read('src/core/runtime/turn-callbacks.ts');
    expect(source).toMatch(/export interface TurnLifecycleCallbacks/);
    expect(source).toMatch(/export interface ProviderLifecycleCallbacks/);
    expect(source).toMatch(/export type RuntimeTurnCallbacks/);
    // runtime.ts turn 入口消费 owner 组合 sink，不再自 L3 整包引 StreamCallbacks
    const runtimeSource = read('src/core/runtime/runtime.ts');
    expect(runtimeSource).toMatch(/import type \{ RuntimeTurnCallbacks \} from '\.\/turn-callbacks\.js';/);
    expect(runtimeSource).not.toMatch(/type StreamCallbacks[^']*from '\.\.\/agent-executor\/index\.js'/);
  });

  it('EventLoop 自持 onTurnStart 并组合自身 stream 投影面（不自 L3 引 StreamCallbacks）', () => {
    const typesSource = read('src/core/event-loop/types.ts');
    expect(typesSource).toMatch(/export interface TurnStartCallback/);
    expect(typesSource).toMatch(/export type EventLoopStreamCallbacks/);
    for (const relative of [
      'src/core/event-loop/stream-callbacks.ts',
      'src/core/event-loop/event-loop.ts',
      'src/core/event-loop/types.ts',
    ]) {
      expect(read(relative)).not.toMatch(/StreamCallbacks[^']*from '\.\.\/agent-executor\/index\.js'/);
    }
  });

  it('Runtime does not forward StreamCallbacks', () => {
    expect(read('src/core/runtime/types.ts')).not.toContain('StreamCallbacks');
    expect(read('src/core/runtime/index.ts')).not.toContain('StreamCallbacks');
  });

  it('cross-module test helpers consume owner-composed callback types', () => {
    // Step H (phase1895): legacy-process-batch helper 已删——EventLoop 驱动测试改经
    // test-event-loop 装配；owner 组合 callback 类型边界锁转移到该 helper 面。
    const testLoop = read('tests/helpers/test-event-loop.ts');
    expect(testLoop).toContain("from '../../src/core/event-loop/index.js'");
    expect(testLoop).not.toMatch(/import type \{ StreamCallbacks \}/);
    expect(read('tests/helpers/runtime-test-internals.ts')).toContain('RuntimeTurnCallbacks');
  });
});
