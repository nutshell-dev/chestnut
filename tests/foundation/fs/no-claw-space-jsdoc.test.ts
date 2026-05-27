import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('fs/types.ts JSDoc', () => {
  it('does not contain "claw space" in JSDoc comments (ML#5 generic)', () => {
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/foundation/fs/types.ts'),
      'utf-8'
    );
    // Remove PathNotInClawSpaceError class name references (those are identifiers, not doc concept)
    const withoutClassName = content.replace(/PathNotInClawSpaceError/g, '');
    expect(withoutClassName).not.toContain('claw space');
  });
});
