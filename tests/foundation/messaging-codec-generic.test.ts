import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const MESSAGING_FILES = [
  'src/foundation/messaging/types.ts',
  'src/foundation/messaging/codec-inbox.ts',
  'src/foundation/messaging/codec-outbox.ts',
  'src/foundation/messaging/outbox-writer.ts',
];

describe('foundation/messaging codec generic metadata invariant', () => {
  it('messaging 域不字面感知 contract_id', () => {
    for (const file of MESSAGING_FILES) {
      const src = readFileSync(file, 'utf-8');
      // ban quoted contract_id literal as string key
      const m = src.match(/['"`]contract_id['"`]/);
      if (m) {
        expect.fail(`messaging/ 持 quoted "contract_id" literal in ${file}: ${m[0]}`);
      }
      // ban schema field declaration `contract_id?: string`
      expect(src, `${file} 持 contract_id?: string field`).not.toMatch(/contract_id\?\s*:\s*string/);
      // ban hardcode `msg.contract_id` direct access
      expect(src, `${file} 持 msg.contract_id 直接访问`).not.toMatch(/msg\.contract_id/);
    }
  });

  it('messaging types.ts 提供 metadata schema', () => {
    const src = readFileSync('src/foundation/messaging/types.ts', 'utf-8');
    expect(src).toMatch(/metadata\?\s*:\s*Record<string,\s*string>/);
  });
});
