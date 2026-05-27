/**
 * @module L5.Runtime.Utils
 * Pure utility helpers for Runtime — 0 this.* / 0 class state 依赖
 */

/**
 * 格式化时间戳为相对时间（'Xs ago' / 'Xm ago' / 'Xh ago' / 'Xd ago' / '' for invalid）
 * 1:1 保 runtime.ts:310-321 body
 */
export function formatTimeAgo(timestamp: string): string {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return '';
  const s = Math.floor(diffMs / 1_000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
