/**
 * Phase 1804: Daemon heartbeat cleanup 边界 ratchet（Daemon 禁止物理 inbox 访问）。
 *
 * daemon.ts 不得再枚举 inbox 目录、按文件名 substring 判断或直接 delete；
 * 必须经 Messaging owner capability（cleanupPendingByType）表达清理意图。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DAEMON_SRC = readFileSync(
  new URL('../../../src/daemon/daemon.ts', import.meta.url), 'utf8');

describe('daemon heartbeat cleanup boundary (phase 1804)', () => {
  it('daemon.ts 不含 _heartbeat_ 文件名判断、不直接 list/delete inbox pending', () => {
    // 注释允许历史引用；ratchet 针对代码级文件名 substring 判断与物理 inbox 操作
    expect(DAEMON_SRC).not.toMatch(/\.includes\(\s*['"]_heartbeat_['"]/);
    expect(DAEMON_SRC).not.toMatch(/\.list\(\s*INBOX_PENDING_DIR/);
    expect(DAEMON_SRC).not.toMatch(/preAssembleFs\.delete\(/);
  });

  it('daemon.ts 经 Messaging owner capability 清理（cleanupPendingByType + barrel 导入）', () => {
    expect(DAEMON_SRC).toMatch(/cleanupPendingByType\('heartbeat'\)/);
    expect(DAEMON_SRC).toMatch(/import\s*\{[^}]*createInboxReader[^}]*\}\s*from\s*'\.\.\/foundation\/messaging\/index\.js'/);
  });

  it('partial failure 有审计证据（CLEANUP_HEARTBEAT_FAILED 消费 typed outcome）', () => {
    expect(DAEMON_SRC).toMatch(/cleanup\.kind\s*===\s*'partial'/);
    expect(DAEMON_SRC).toContain('CLEANUP_HEARTBEAT_FAILED');
  });
});
