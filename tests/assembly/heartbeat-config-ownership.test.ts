/**
 * Phase 1870 Step B: heartbeat 字段声明归属（HEARTBEAT-CONFIG-SCHEMA-WRONG-OWNER 收口）。
 *
 * 契约：
 * - `heartbeat_interval_ms` 声明唯一在 Heartbeat owner（heartbeatConfigSchema）；
 *   runtimeMotionConfigSchema 不再持有该字段（原 Owner: runtime 的越界声明迁出）；
 * - Assembly 组合回 motion 段 → YAML 路径 `motion.heartbeat_interval_ms` 不变、
 *   省略等价默认 0、显式值照常解析（无配置迁移 / 无兼容 shim）；
 * - 默认值单源（HEARTBEAT_DEFAULT_INTERVAL_MS），init 模板引用同一常量。
 */
import { describe, it, expect } from 'vitest';
import {
  heartbeatConfigSchema,
  HEARTBEAT_DEFAULT_INTERVAL_MS,
} from '../../src/core/heartbeat/index.js';
import { runtimeMotionConfigSchema } from '../../src/core/runtime/index.js';
import { buildTestGlobalConfig } from '../helpers/global-config.js';

describe('phase 1870: heartbeat 字段声明归属', () => {
  it('声明点唯一：heartbeat schema 持有该字段、runtime schema 不再持有', () => {
    expect(Object.keys(heartbeatConfigSchema.shape)).toContain('heartbeat_interval_ms');
    expect(Object.keys(runtimeMotionConfigSchema.shape)).not.toContain('heartbeat_interval_ms');
  });

  it('motion.heartbeat_interval_ms 显式值经组合 schema 照常解析（YAML 路径不变）', () => {
    const config = buildTestGlobalConfig({ motion: { heartbeat_interval_ms: 5000 } });
    expect(config.motion.heartbeat_interval_ms).toBe(5000);
  });

  it('省略 motion 段/字段 → 默认 0（schema 默认单源）', () => {
    const config = buildTestGlobalConfig({});
    expect(config.motion.heartbeat_interval_ms).toBe(HEARTBEAT_DEFAULT_INTERVAL_MS);
    expect(HEARTBEAT_DEFAULT_INTERVAL_MS).toBe(0);
    // min(0) 约束随声明保留（负值拒绝）
    expect(heartbeatConfigSchema.safeParse({ heartbeat_interval_ms: -1 }).success).toBe(false);
  });

  it('组合后 motion 段仍含 runtime 其余字段（迁移只动 heartbeat 一行）', () => {
    const config = buildTestGlobalConfig({});
    expect(config.motion.max_concurrent_tasks).toBeGreaterThan(0);
    expect(typeof config.motion.llm_idle_timeout_ms).toBe('number');
  });
});
