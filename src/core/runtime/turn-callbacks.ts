/**
 * @module L4.Runtime.TurnCallbacks
 * @layer L4 运行时层
 * @depends L3.AgentExecutor（stream 段协议）
 * @consumers L4.Runtime, L5.EventLoop（组合自身投影面）
 *
 * phase 1856 (AE-D5): turn / provider 生命周期回调语义归 invoke owner（Runtime）。
 * 此前由 L3 agent-executor 的 StreamCallbacks 跨层持有——其循环从不触发这些回调。
 * invoke 点：runtime.ts _processTurnImpl（onTurnEnd）、handleTurnInterrupt
 * （onTurnError/onTurnInterrupted）、_runReact 装配（onProviderInfo/
 * onProviderFailover/onProviderFailed）。onTurnStart 的唯一 invoke 点在
 * EventLoop，其类型归 EventLoop（event-loop/types.ts TurnStartCallback）。
 */

import type { StreamCallbacks } from '../agent-executor/index.js';

/** Turn 生命周期回调（Runtime invoke 面；onTurnStart 归 EventLoop）。 */
export interface TurnLifecycleCallbacks {
  onTurnEnd?: () => void;
  onTurnError?: (error: string) => void;
  onTurnInterrupted?: (cause: string, message?: string) => void;
}

/** Provider 生命周期回调（Runtime invoke 面）。 */
export interface ProviderLifecycleCallbacks {
  onProviderInfo?: (info: { name: string; model: string; isFallback: boolean }) => void;
  /** Provider timed out mid-stream, failover starting */
  onProviderFailover?: (info: { from: string; timeoutMs: number }) => void;
  /** Provider failed, failover continuing to next provider */
  onProviderFailed?: (info: { provider: string; model: string; error: string }) => void;
}

/**
 * Runtime turn 入口消费的最小组合 sink：
 * stream 段（AgentExecutor-owned StreamCallbacks，透传 runReact）
 * + 本模块 invoke 的 turn/provider 生命周期。不整包转发 StreamCallbacks。
 */
export type RuntimeTurnCallbacks = StreamCallbacks & TurnLifecycleCallbacks & ProviderLifecycleCallbacks;
