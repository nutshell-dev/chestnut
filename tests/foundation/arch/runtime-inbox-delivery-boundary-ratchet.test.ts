import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1365: Runtime inbox delivery boundary', () => {
  it('Messaging owns an exact seven-operation delivery session', () => {
    const source = read('src/foundation/messaging/inbox-reader.ts');
    const barrel = read('src/foundation/messaging/index.ts');
    const body = source.match(
      /export interface InboxDeliverySession \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body;

    expect(body).toBeDefined();
    expect(body?.match(/^\s*[a-zA-Z][A-Za-z]+\(/gm)).toHaveLength(7);
    for (const member of [
      'init',
      'drainAndDeliver',
      'ack',
      'nack',
      'markMisrouted',
      'peekMetas',
      'peekPending',
    ]) {
      expect(body).toContain(`${member}(`);
    }
    expect(source).toContain('drainAndDeliver(): Promise<InboxDeliveryBatch>');
    expect(source).toContain('export class InboxReader implements InboxDeliverySession');
    expect(barrel).toContain('InboxDeliverySession');
    expect(barrel).toContain('InboxDeliveryBatch');
  });

  it('Runtime dependencies and state consume only the delivery session', () => {
    const types = read('src/core/runtime/types.ts');
    const runtime = read('src/core/runtime/runtime.ts');

    expect(types).toContain('readonly inboxReader: InboxDeliverySession');
    expect(types).not.toMatch(/import type \{[^}]*\bInboxReader\b[^}]*\} from '..\/..\/foundation\/messaging\/index\.js'/s);
    expect(runtime).toContain('private inboxReader!: InboxDeliverySession');
    expect(runtime).not.toMatch(/import type \{[^}]*\bInboxReader\b[^}]*\} from '..\/..\/foundation\/messaging\/index\.js'/s);
  });
});
