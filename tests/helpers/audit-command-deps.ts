import type { RootConfigReader } from '../../src/assembly/index.js';
import type { AuditCommandDeps } from '../../src/cli/commands/audit-command-deps.js';

type FsFactory = AuditCommandDeps['fsFactory'];
type LoadGlobal = RootConfigReader['loadGlobal'];
type LoadClaw = RootConfigReader['loadClaw'];

export interface FakeAuditRootConfigOptions {
  loadGlobal?: LoadGlobal;
  loadClaw?: LoadClaw;
}

/** Direct Audit command tests inject the owner-facing reader instead of mocking Assembly internals. */
export function makeAuditCommandDeps(
  fsFactory: FsFactory,
  options: FakeAuditRootConfigOptions = {},
): AuditCommandDeps {
  return {
    fsFactory,
    rootConfig: {
      loadGlobal: options.loadGlobal ?? (() => ({}) as ReturnType<LoadGlobal>),
      loadClaw: options.loadClaw ?? ((configPath) => (
        configPath.includes('test-claw') || configPath.includes('empty-claw')
          ? ({} as NonNullable<ReturnType<LoadClaw>>)
          : undefined
      )),
    },
  };
}
