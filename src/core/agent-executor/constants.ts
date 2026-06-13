// phase 194: REACT_DEFAULT_MAX_TOKENS removed — provider adapter own its API protocol
// (Anthropic must-set via model cap table fallback; OpenAI/Gemini conditional include).
/**
 * Maximum consecutive parse errors before aborting（LLM response 解析失败连续上限）.
 * Derivation: 3 = 经验值 / 1-2 parse fail 可能 transient（LLM 短暂输出格式错）/ ≥ 3 表 LLM
 * 输出确性问题、继续浪费 token / 配 DEFAULT_VERIFICATION_ATTEMPTS=3 同型经验值.
 */
export const MAX_CONSECUTIVE_PARSE_ERRORS = 3;

/**
 * Maximum consecutive max_tokens tool_use before aborting（LLM 输出截断的连续 tool_use 上限）.
 * Derivation: 3 = 同 MAX_CONSECUTIVE_PARSE_ERRORS 经验值 / 短期 max_tokens 截断可能 prompt
 * 太长、连续 3 次表 prompt design 真问题需 abort 让 caller 改 / 防 token 浪费.
 */
export const MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE = 3;
