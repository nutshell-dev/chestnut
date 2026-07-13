import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noBareTempdirInTests from '../../../.config/eslint-rules/no-bare-tempdir-in-tests.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
});

describe('eslint custom rule: no-bare-tempdir-in-tests (phase 998)', () => {
  ruleTester.run('no-bare-tempdir-in-tests', noBareTempdirInTests, {
    valid: [
      // createTempDir / createTrackedTempDir from temp.ts are OK
      { code: "import { createTempDir } from '../utils/temp.js';", filename: 'tests/core/example.test.ts' },
      // importing tmpdir is OK; calling it is not
      { code: "import { tmpdir } from 'node:os';", filename: 'tests/core/example.test.ts' },
      // other os imports are OK
      { code: "import { hostname } from 'node:os';", filename: 'tests/core/example.test.ts' },
      // other fs imports are OK
      { code: "import { readFile } from 'node:fs';", filename: 'tests/core/example.test.ts' },
      // mock / rendered strings are OK
      { code: "const x = '/tmp/chestnut-test/claws/test';", filename: 'tests/core/example.test.ts' },
      // mkdtemp with os.tmpdir() prefix is OK
      { code: "import * as fs from 'node:fs'; import * as os from 'node:os'; fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'prefix-'));", filename: 'tests/core/example.test.ts' },
      // namespace alias for os + tmpdir inside mkdtemp arg is OK
      { code: "import * as nodeOs from 'node:os'; import * as fs from 'node:fs'; fs.mkdtempSync(require('node:path').join(nodeOs.tmpdir(), 'prefix-'));", filename: 'tests/core/example.test.ts' },
      // fsp.mkdtemp with os.tmpdir() prefix is OK
      { code: "import * as fsp from 'fs/promises'; import * as os from 'node:os'; await fsp.mkdtemp(require('node:path').join(os.tmpdir(), 'prefix-'));", filename: 'tests/core/example.test.ts' },
    ],
    invalid: [
      {
        code: "import { mkdtemp } from 'node:fs';",
        filename: 'tests/core/example.test.ts',
        errors: [{ messageId: 'noBareMkdtemp' }],
      },
      {
        code: "import { mkdtempSync } from 'fs';",
        filename: 'tests/core/example.test.ts',
        errors: [{ messageId: 'noBareMkdtemp' }],
      },
      {
        code: 'import * as os from "node:os"; const t = os.tmpdir();',
        filename: 'tests/core/example.test.ts',
        errors: [{ messageId: 'noBareOsTmpdir' }],
      },
      {
        code: 'import * as nodeOs from "node:os"; const t = nodeOs.tmpdir();',
        filename: 'tests/core/example.test.ts',
        errors: [{ messageId: 'noBareOsTmpdir' }],
      },
      {
        code: "import { tmpdir } from 'node:os'; const t = tmpdir();",
        filename: 'tests/core/example.test.ts',
        errors: [{ messageId: 'noBareTempdir' }],
      },
      {
        code: "import { tmpdir as getTmp } from 'node:os'; const t = getTmp();",
        filename: 'tests/core/example.test.ts',
        errors: [{ messageId: 'noBareTempdir' }],
      },
      {
        code: "import { mkdtemp } from 'node:fs'; const d = mkdtemp('prefix-');",
        filename: 'tests/core/example.test.ts',
        errors: [{ messageId: 'noBareMkdtemp' }, { messageId: 'noBareMkdtemp' }],
      },
      {
        code: "import * as fs from 'node:fs'; const d = fs.mkdtempSync('/tmp/test-');",
        filename: 'tests/core/example.test.ts',
        errors: [{ messageId: 'noHardcodedTmp' }],
      },
      {
        code: "import * as fsNative from 'fs'; const d = fsNative.mkdtemp('/tmp/test-');",
        filename: 'tests/core/example.test.ts',
        errors: [{ messageId: 'noHardcodedTmp' }],
      },
      {
        code: "import * as fsp from 'fs/promises'; const d = await fsp.mkdtemp('/tmp/test-');",
        filename: 'tests/core/example.test.ts',
        errors: [{ messageId: 'noHardcodedTmp' }],
      },
      {
        code: "import * as fs from 'node:fs'; const d = fs.mkdtempSync(`/tmp/test-XXXXXX`);",
        filename: 'tests/core/example.test.ts',
        errors: [{ messageId: 'noHardcodedTmp' }],
      },
      {
        code: "import * as fs from 'node:fs'; const d = fs.realpathSync('/tmp');",
        filename: 'tests/core/example.test.ts',
        errors: [{ messageId: 'noHardcodedTmp' }],
      },
      {
        code: "import { realpathSync } from 'node:fs'; const d = realpathSync('/tmp');",
        filename: 'tests/core/example.test.ts',
        errors: [{ messageId: 'noHardcodedTmp' }],
      },
    ],
  });

  it('rule loaded', () => {
    // dummy test for vitest describe completeness
  });
});
