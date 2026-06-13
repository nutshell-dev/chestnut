import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noSilentXWithoutAllowedPattern from '../../../.config/eslint-rules/no-silent-x-without-allowed-pattern.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-silent-x-without-allowed-pattern (phase 349)', () => {
  ruleTester.run('no-silent-x-without-allowed-pattern', noSilentXWithoutAllowedPattern, {
    valid: [
      // out of src/
      { code: 'try { foo(); } catch { }', filename: 'tests/foo.test.ts' },
      // .d.ts skip
      { code: 'try { foo(); } catch { }', filename: 'src/types.d.ts' },
      // canonical silent annotation (block)
      {
        code: 'try { foo(); } catch { /* silent: race */ }',
        filename: 'src/core/runtime/runtime.ts',
      },
      // canonical silent annotation (line)
      {
        code: 'try { foo(); } catch {\n  // silent: by-design\n}',
        filename: 'src/core/runtime/runtime.ts',
      },
      // audit
      {
        code: 'try { foo(); } catch (e) { audit.write(e); }',
        filename: 'src/core/runtime/runtime.ts',
      },
      // auditWriter?.write
      {
        code: 'try { foo(); } catch (e) { auditWriter?.write({ kind: "ERR" }); }',
        filename: 'src/core/runtime/runtime.ts',
      },
      // throw
      {
        code: 'try { foo(); } catch (e) { throw e; }',
        filename: 'src/core/runtime/runtime.ts',
      },
      // console.error
      {
        code: 'try { foo(); } catch (e) { console.error(e); }',
        filename: 'src/core/runtime/runtime.ts',
      },
      // process.exit
      {
        code: 'try { foo(); } catch { process.exit(1); }',
        filename: 'src/core/runtime/runtime.ts',
      },
      // handleCliError helper
      {
        code: 'try { foo(); } catch (e) { handleCliError(e); }',
        filename: 'src/cli/commands/x.ts',
      },
      // log() helper
      {
        code: 'try { foo(); } catch (e) { log(e); }',
        filename: 'src/core/runtime/runtime.ts',
      },
      // structured return success
      {
        code: 'function f() { try { foo(); } catch { return { error: "x" }; } }',
        filename: 'src/core/runtime/runtime.ts',
      },
      // return false
      {
        code: 'function f() { try { foo(); } catch { return false; } }',
        filename: 'src/core/runtime/runtime.ts',
      },
      // return;
      {
        code: 'function f() { try { foo(); } catch { return; } }',
        filename: 'src/core/runtime/runtime.ts',
      },
      // return [];
      {
        code: 'function f() { try { foo(); } catch { return []; } }',
        filename: 'src/core/runtime/runtime.ts',
      },
      // continue;
      {
        code: 'for (;;) { try { foo(); } catch { continue; } }',
        filename: 'src/core/runtime/runtime.ts',
      },
      // if (err
      {
        code: 'try { foo(); } catch (err) { if (err.code) handle(err); }',
        filename: 'src/core/runtime/runtime.ts',
      },
      // assignment errorText =
      {
        code: 'let errorText = ""; try { foo(); } catch (e) { errorText = String(e); }',
        filename: 'src/core/runtime/runtime.ts',
      },
      // Promise.reject in arrow .catch
      {
        code: 'foo().catch((e) => { Promise.reject(e); });',
        filename: 'src/core/runtime/runtime.ts',
      },
      // generic *Audit*.write
      {
        code: 'try { foo(); } catch (e) { contractAudit.write({ kind: "X" }); }',
        filename: 'src/core/contract/manager.ts',
      },
      // generic *Error*(
      {
        code: 'function f() { try { foo(); } catch (e) { CustomError(e); } }',
        filename: 'src/core/runtime/runtime.ts',
      },
      // .catch arrow with audit
      {
        code: 'foo().catch((e) => { audit.write(e); });',
        filename: 'src/core/runtime/runtime.ts',
      },
    ],
    invalid: [
      // empty catch in business path
      {
        code: 'try { foo(); } catch { }',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'silentXNotAllowed' }],
      },
      // empty .catch(() => {})
      {
        code: 'foo().catch(() => {});',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'silentXNotAllowed' }],
      },
      // catch with arbitrary code but no allowed signal
      {
        code: 'let x = 0; try { foo(); } catch { x = 1; }',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'silentXNotAllowed' }],
      },
      // catch with helper that doesn't match patterns
      {
        code: 'function bar(){} try { foo(); } catch (e) { bar(); }',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'silentXNotAllowed' }],
      },
      // .catch arrow with random body
      {
        code: 'let counter = 0; foo().catch(() => { counter += 1; });',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'silentXNotAllowed' }],
      },
    ],
  });

  it('rule loaded', () => {});
});
