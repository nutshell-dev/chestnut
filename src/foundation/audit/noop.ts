/**
 * phase 1893: 静默 AuditLog（fallback 场景专用，非生产路径）。
 *
 * 完整接口面全 noop——`write` 丢弃、`preview`/`message`/`summary` 返回空串、
 * `artifact`/`loss` 返回空数组——替代此前 5 处裸 `{ write: () => {} }` 经
 * 双重 cast 冒充 AuditLog 的 stub（其余方法被 cast 掩盖、调用即 TypeError）。
 */
import type { AuditLog } from './types.js';

export const noopAuditLog: AuditLog = {
  __brand: 'AuditLog',
  write: () => {},
  preview: () => '',
  message: () => '',
  summary: () => '',
  artifact: () => [],
  loss: () => [],
};
