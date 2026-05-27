/**
 * create-runtime — tryReadOptionalSection helper tests (R72-P1-4)
 *
 * Covers:
 * - ENOENT / FS_NOT_FOUND → silent skip (no audit)
 * - Other errors → audit with OPTIONAL_SECTION_READ_FAILED
 * - Success → trimmed content returned
 */

import { describe, it, expect, vi } from 'vitest';
import { tryReadOptionalSection } from '../../../src/core/runtime/create-runtime.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';

describe('tryReadOptionalSection', () => {
  it('returns undefined on ENOENT (silent skip)', async () => {
    const fs = {
      read: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    };
    const audit = vi.fn();
    const result = await tryReadOptionalSection(fs as any, 'USER.md', { write: audit } as any);
    expect(result).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it('returns undefined on FS_NOT_FOUND (silent skip)', async () => {
    const fs = {
      read: vi.fn().mockRejectedValue(Object.assign(new Error('FS_NOT_FOUND'), { code: 'FS_NOT_FOUND' })),
    };
    const audit = vi.fn();
    const result = await tryReadOptionalSection(fs as any, 'IDENTITY.md', { write: audit } as any);
    expect(result).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it('audits on non-ENOENT error', async () => {
    const fs = {
      read: vi.fn().mockRejectedValue(new Error('permission denied')),
    };
    const audit = vi.fn();
    const result = await tryReadOptionalSection(fs as any, 'USER.md', { write: audit } as any);
    expect(result).toBeUndefined();
    expect(audit).toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.OPTIONAL_SECTION_READ_FAILED,
      'path=USER.md',
      expect.stringMatching(/reason=permission denied/),
    );
  });

  it('returns trimmed content on success', async () => {
    const fs = {
      read: vi.fn().mockResolvedValue('  hello  \n'),
    };
    const result = await tryReadOptionalSection(fs as any, 'USER.md', undefined);
    expect(result).toBe('hello');
  });

  it('returns undefined on empty content after trim', async () => {
    const fs = {
      read: vi.fn().mockResolvedValue('   \n  '),
    };
    const audit = vi.fn();
    const result = await tryReadOptionalSection(fs as any, 'SOUL.md', { write: audit } as any);
    expect(result).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });
});
