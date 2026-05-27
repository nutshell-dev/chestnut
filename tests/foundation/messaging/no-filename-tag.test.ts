/**
 * filenameTag dead field static grep invariant (phase 1183 r129 D fork F.10)
 *
 * Coverage:
 * - src/ 全栈 0 `filenameTag` literal occurrence
 * - 防 NEW pending PR 引入 NEW filenameTag 字段使用
 *
 * mirror phase 964 silent-x-invariant + phase 1019 audit-events-snapshot-lock + phase 1171 chat-viewport-unref
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

describe('filenameTag dead field static grep invariant (phase 1183 F.10)', () => {
  it('src/ 全栈 0 filenameTag literal occurrence', () => {
    let result = '';
    try {
      result = execSync('grep -rn "filenameTag" src/ --include="*.ts"', {
        encoding: 'utf-8',
      }).trim();
    } catch (err) {
      // grep returns exit code 1 when 0 match (expected for invariant)
      if ((err as { status?: number }).status === 1) {
        result = '';
      } else {
        throw err;
      }
    }
    expect(result, `filenameTag 应已 phase 1183 delete cascade 全清\n实测残留:\n${result}`).toBe('');
  });
});
