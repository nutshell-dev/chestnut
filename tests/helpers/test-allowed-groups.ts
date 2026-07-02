import { CALLER_TYPE_TO_GROUPS } from '../../src/core/permissions/caller-types.js';

/**
 * phase 785: default allowed tool groups for test Runtime instances.
 * Tests should not import caller-types directly; use this helper instead.
 */
export const TEST_ALLOWED_GROUPS: ReadonlySet<string> = CALLER_TYPE_TO_GROUPS.claw;
