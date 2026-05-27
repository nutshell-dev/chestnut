import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('stream/writer.ts JSDoc', () => {
  it('does not contain "daemon" in JSDoc comments (ML#5 generic)', () => {
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/foundation/stream/writer.ts'),
      'utf-8'
    );
    expect(content).not.toContain('daemon');
  });
});
