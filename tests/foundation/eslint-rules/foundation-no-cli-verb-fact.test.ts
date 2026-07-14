import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import foundationNoCliVerbFact from '../../../.config/eslint-rules/foundation-no-cli-verb-fact.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: foundation-no-cli-verb-fact (phase 330)', () => {
  ruleTester.run('foundation-no-cli-verb-fact', foundationNoCliVerbFact, {
    valid: [
      // out of foundation/
      {
        code: 'export const CLAW_VERB_FACTS = {};',
        filename: 'src/cli/help/verb-facts.ts',
      },
      {
        code: 'const v = VerbFact;',
        filename: 'src/cli/index.ts',
      },
      // foundation/ + unrelated identifier
      {
        code: 'const x = 1;',
        filename: 'src/foundation/audit/events.ts',
      },
    ],
    invalid: [
      // foundation/ with cli-help path
      {
        code: 'export const X = 1;',
        filename: 'src/foundation/cli-help/foo.ts',
        errors: [{ messageId: 'cliHelpPath' }],
      },
      // foundation/ with verb-facts.ts filename
      {
        code: 'export const X = 1;',
        filename: 'src/foundation/verb-facts.ts',
        errors: [{ messageId: 'cliHelpPath' }],
      },
      // foundation/ + banned symbol Identifier
      {
        code: 'const v = CLAW_VERB_FACTS;',
        filename: 'src/foundation/audit/events.ts',
        errors: [{ messageId: 'verbFactSymbol' }],
      },
      {
        code: 'const v = VerbFact;',
        filename: 'src/foundation/audit/events.ts',
        errors: [{ messageId: 'verbFactSymbol' }],
      },
    ],
  });

});
