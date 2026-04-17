/**
 * SessionStore types (L2)
 *
 * Session data structure for current.json persistence.
 */

import type { Message } from '../../types/message.js';

export interface SessionData {
  version: number;
  clawId: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

export interface LoadResult {
  session: SessionData;
  source: 'current' | 'archive' | 'empty';
}
