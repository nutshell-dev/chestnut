import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('Runtime TraceId owner boundary (phase 1502)', () => {
  it('AuditLog barrel remains the TraceId protocol owner', () => {
    const auditBarrel = read('src/foundation/audit/index.ts');
    expect(auditBarrel).toMatch(/export type \{[^}]*TraceId[^}]*\} from '\.\/types\.js';/s);
    expect(auditBarrel).toMatch(/export \{ makeTraceId \} from '\.\/types\.js';/);
  });

  it('Runtime imports TraceId and makeTraceId directly from AuditLog', () => {
    expect(read('src/core/runtime/runtime.ts')).toMatch(
      /import \{[^}]*makeTraceId[^}]*type TraceId[^}]*\} from '\.\.\/\.\.\/foundation\/audit\/index\.js';/s,
    );
  });

  it('Runtime has no TraceId forwarding facade', () => {
    expect(fs.existsSync(path.join(root, 'src/core/runtime/types/trace-id.ts'))).toBe(false);
  });
});
