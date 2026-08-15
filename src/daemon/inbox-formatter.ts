/**
 * @module L6.Daemon
 * phase 1243: Daemon 自家 inbox 消息 rendering declarations。
 *
 * 业务语义：daemon 启动期触发的「请检查活跃契约并继续执行」通知措辞。
 * 使用标准 system presentation（sender body 已自含业务措辞）。
 */

import type { InboxMessageTypeDeclaration } from '../foundation/messaging/index.js';

export const DAEMON_INBOX_MESSAGE_TYPES = [
  { owner: 'daemon', type: 'startup_check', rendering: { kind: 'standard', presentation: 'system' } },
] as const satisfies readonly InboxMessageTypeDeclaration[];
