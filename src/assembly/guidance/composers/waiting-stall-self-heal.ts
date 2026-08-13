/**
 * @module L6.Assembly.Guidance
 * phase 1383 (P2b U3): NO_GUIDANCE by-design.
 *
 * 触发: daemon in-process waiting-stall 自检（daemon/waiting-stall.ts）
 * 接收方: daemon 自己（self-inbox，强制重入轮/重扫 inbox）
 * body 自足: 含「execution stalled ... rescanning inbox ... resuming」措辞
 * 跨层 CLI hint 需要: ❌
 */

import { NO_GUIDANCE } from '../types.js';

export const composer = NO_GUIDANCE;
