/**
 * SessionStore types (L2)
 *
 * Session data structure for messages.json persistence.
 */

import type { Message } from '../../types/message.js';

export interface SessionData {
  version: number;
  clawId: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}
