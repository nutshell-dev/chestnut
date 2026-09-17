/**
 * phase 1850 Step C — applyBlockIdAssignments 原语矩阵。
 */

import { describe, it, expect } from 'vitest';
import { applyBlockIdAssignments } from '../../../src/foundation/dialog-store/apply-block-ids.js';
import type { BlockIdAssignment } from '../../../src/foundation/dialog-store/types.js';
import type { Message } from '../../../src/foundation/dialog-store/canonical-message.js';

function makeMessages(): Message[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'a' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'b1' }, { type: 'text', text: 'b2' }] },
    { role: 'user', content: 'plain string' },
  ] as Message[];
}

describe('applyBlockIdAssignments (phase 1850 Step C)', () => {
  it('正常：按 (messageIndex, blockIndex) 写回 blockId', () => {
    const messages = makeMessages();
    const assignments: BlockIdAssignment[] = [
      { messageIndex: 0, blockIndex: 0, blockId: 'id-a', shortId: 'id-a-sh' },
      { messageIndex: 1, blockIndex: 1, blockId: 'id-b2', shortId: 'id-b2-sh' },
    ];

    applyBlockIdAssignments(messages, assignments);

    const blockA = (messages[0].content as any[])[0] as any;
    const blockB1 = (messages[1].content as any[])[0] as any;
    const blockB2 = (messages[1].content as any[])[1] as any;
    expect(blockA.blockId).toBe('id-a');
    expect(blockB1.blockId).toBeUndefined();   // 未在 assignments 中的块不动
    expect(blockB2.blockId).toBe('id-b2');
  });

  it('空 assignments → no-op', () => {
    const messages = makeMessages();
    const before = JSON.parse(JSON.stringify(messages));

    applyBlockIdAssignments(messages, []);

    expect(messages).toEqual(before);
  });

  it('越界：messageIndex / blockIndex 越界不抛、无写', () => {
    const messages = makeMessages();
    const before = JSON.parse(JSON.stringify(messages));
    const assignments: BlockIdAssignment[] = [
      { messageIndex: 99, blockIndex: 0, blockId: 'id-x', shortId: 'x' },
      { messageIndex: 1, blockIndex: 99, blockId: 'id-y', shortId: 'y' },
      { messageIndex: -1, blockIndex: 0, blockId: 'id-neg', shortId: 'n' },
    ];

    expect(() => applyBlockIdAssignments(messages, assignments)).not.toThrow();
    expect(messages).toEqual(before);
  });

  it('string content 消息跳过不抛', () => {
    const messages = makeMessages();
    const assignments: BlockIdAssignment[] = [
      { messageIndex: 2, blockIndex: 0, blockId: 'id-s', shortId: 's' },
    ];

    expect(() => applyBlockIdAssignments(messages, assignments)).not.toThrow();
    expect(messages[2].content).toBe('plain string');
  });

  it('已带 blockId 的块不覆盖', () => {
    const messages = makeMessages();
    ((messages[0].content as any[])[0] as any).blockId = 'existing-id';
    const assignments: BlockIdAssignment[] = [
      { messageIndex: 0, blockIndex: 0, blockId: 'new-id', shortId: 'n' },
    ];

    applyBlockIdAssignments(messages, assignments);

    expect(((messages[0].content as any[])[0] as any).blockId).toBe('existing-id');
  });
});
