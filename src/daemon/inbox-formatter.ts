/**
 * @module L6.Daemon
 * phase 1419: DaemonLoop 自家 'startup_check' inbox 消息 formatter（phase 1414
 * 落地完整化 sister）。
 *
 * 业务语义：daemon 启动期触发的「请检查活跃契约并继续执行」通知措辞。
 * 当前 trivial passthrough（sender body 已自含业务措辞）— 措辞业主自定、未来
 * 加特殊措辞时改本 file 单点。
 */

import type { MessageFormatter, MessageFormatterRegistry } from '../foundation/messaging/index.js';

export const formatStartupCheck: MessageFormatter = async ({ body, timestampSec }) =>
  `[system message${timestampSec}] ${body}`;

export function registerDaemonFormatters(registry: MessageFormatterRegistry): void {
  registry.register('startup_check', formatStartupCheck);
}
