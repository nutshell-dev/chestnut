// REACT_DEFAULT_MAX_TOKENS moved to step-executor/constants.ts (canonical owner,
// step-executor is the primary consumer). Import from there.
/** Maximum consecutive parse errors before aborting */
export const MAX_CONSECUTIVE_PARSE_ERRORS = 3;

/** Maximum consecutive max_tokens tool_use before aborting */
export const MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE = 3;
