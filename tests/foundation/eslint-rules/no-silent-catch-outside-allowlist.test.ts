import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noSilentCatchOutsideAllowlist from '../../../.config/eslint-rules/no-silent-catch-outside-allowlist.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-silent-catch-outside-allowlist (phase 343)', () => {
  ruleTester.run('no-silent-catch-outside-allowlist', noSilentCatchOutsideAllowlist, {
    valid: [
      // out of src/
      { code: 'try { foo(); } catch { /* silent: x */ }', filename: 'tests/foo.test.ts' },
      // block catch with NO silent marker, even empty body — NOT flagged
      // (vitest pattern only caught `{ /* silent` block form; ESLint mirrors).
      { code: 'try { foo(); } catch { }', filename: 'src/core/runtime/runtime.ts' },
      { code: 'try { foo(); } catch (e) { handle(e); }', filename: 'src/core/runtime/runtime.ts' },
      // allowlist: orchestrator.ts
      {
        code: 'try { foo(); } catch { /* silent: generator already closed */ }',
        filename: 'src/foundation/llm-orchestrator/orchestrator.ts',
      },
      // allowlist: watcher.ts
      {
        code: 'try { foo(); } catch { }',
        filename: 'src/foundation/file-watcher/watcher.ts',
      },
      // allowlist: claw-trace.ts bare catch
      {
        code: 'try { foo(); } catch { /* silent: skip */ }',
        filename: 'src/cli/commands/claw-trace.ts',
      },
      // allowlist: subagent-helpers.ts promise-form
      {
        code: 'foo().catch(() => {});',
        filename: 'src/cli/commands/subagent-helpers.ts',
      },
      // business path with audit (non-silent body)
      {
        code: 'try { foo(); } catch (e) { audit.write(e); }',
        filename: 'src/core/runtime/runtime.ts',
      },
      // business path with throw (non-silent body)
      {
        code: 'try { foo(); } catch (e) { throw e; }',
        filename: 'src/core/contract/manager.ts',
      },
      // business path with console (non-silent body)
      {
        code: 'try { foo(); } catch (e) { console.error(e); }',
        filename: 'src/core/contract/manager.ts',
      },
      // promise-form .catch with non-empty body
      {
        code: 'foo().catch((e) => { audit.write(e); });',
        filename: 'src/core/runtime/runtime.ts',
      },
      // non-silent comment inside catch body (no `silent:` marker)
      {
        code: 'try { foo(); } catch (e) { /* handle later */ bar(e); }',
        filename: 'src/core/runtime/runtime.ts',
      },
    ],
    invalid: [
      // business path silent-marker comment catch
      {
        code: 'try { foo(); } catch { /* silent: race */ }',
        filename: 'src/core/contract/manager.ts',
        errors: [{ messageId: 'silentCatchOutside' }],
      },
      // business path block catch with silent-marker comment + body
      {
        code: 'try { foo(); } catch (e) { /* silent: best-effort */ doIt(); }',
        filename: 'src/core/contract/manager.ts',
        errors: [{ messageId: 'silentCatchOutside' }],
      },
      // business path bare .catch(() => {})
      {
        code: 'foo().catch(() => {});',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'silentCatchOutside' }],
      },
      // business path .catch((e) => {})
      {
        code: 'foo().catch((e) => {});',
        filename: 'src/foundation/messaging/inbox-writer.ts',
        errors: [{ messageId: 'silentCatchOutside' }],
      },
    ],
  });

  it('rule loaded', () => {});
});
