import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('CallerSnapshot owner boundary (phase 1495)', () => {
  it('ToolProtocol remains the definition and named-export owner', () => {
    expect(read('src/foundation/tool-protocol/types.ts')).toMatch(/export interface CallerSnapshot/);
    expect(read('src/foundation/tool-protocol/index.ts')).toMatch(/\bCallerSnapshot\b/);
  });

  it('Tools types does not re-export CallerSnapshot', () => {
    expect(read('src/foundation/tools/types.ts')).not.toMatch(/^export type \{ CallerSnapshot \};$/m);
  });

  it('Tools still consumes CallerSnapshot for its access-gate signature', () => {
    const types = read('src/foundation/tools/types.ts');
    expect(types).toMatch(/import type \{[^}]*CallerSnapshot[^}]*\} from '\.\.\/tool-protocol\/index\.js';/);
    expect(types).toMatch(/getCallerSnapshot\?\(\): Promise<CallerSnapshot>;/);
  });
});
