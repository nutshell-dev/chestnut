import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noBareTempdirInTests from '../../../.config/eslint-rules/no-bare-tempdir-in-tests.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
});

describe('eslint custom rule: no-bare-tempdir-in-tests (phase 991)', () => {
  ruleTester.run('no-bare-tempdir-in-tests', noBareTempdirInTests, {
    valid: [
      // createTempDir / createTrackedTempDir from temp.ts are OK
      { code: "import { createTempDir } from '../utils/temp.js';", filename: 'tests/core/example.test.ts' },
      // other os imports are OK
      { code: "import { hostname } from 'node:os';", filename: 'tests/core/example.test.ts' },
      // other fs imports are OK
      { code: "import { readFile } from 'node:fs';", filename: 'tests/core/example.test.ts' },
    ],
    invalid: [
      {
        code: "import { tmpdir } from 'node:os';",
        filename: 'tests/core/example.test.ts',
        errors: [{ messageId: 'noBareTempdir' }],
      },
      {
        code: "import { tmpdir } from 'os';",
        filename: 'tests/core/example.test.ts',
        errors: [{ messageId: 'noBareTempdir' }],
      },
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
    ],
  });

  it('rule loaded', () => {
    // dummy test for vitest describe completeness
  });
});
