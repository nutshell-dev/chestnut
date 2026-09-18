// phase 194: REACT_DEFAULT_MAX_TOKENS removed — provider adapter own its API protocol
// (Anthropic must-set via model cap table fallback; OpenAI/Gemini conditional include).
/**
 * Maximum parse-error strikes before aborting（LLM response 解析失败累计上限）.
 * phase 1856 (AE-D4): strike 语义 = 自上次成功步以来累计、另类失败（max_tokens）不重置；
 * 常量名保留「CONSECUTIVE」仅为对外标识兼容，语义为累计 strike。
 * Derivation: 3 = 经验值 / 1-2 parse fail 可能 transient（LLM 短暂输出格式错）/ ≥ 3 表 LLM
 * 输出确性问题、继续浪费 token / 配 DEFAULT_VERIFICATION_ATTEMPTS=3 同型经验值.
 */
export const MAX_CONSECUTIVE_PARSE_ERRORS = 3;

/**
 * Maximum max_tokens tool_use strikes before aborting（LLM 输出截断的累计 tool_use 上限）.
 * phase 1856 (AE-D4): strike 语义 = 自上次成功步以来累计、另类失败（parse error）不重置；
 * 常量名保留「CONSECUTIVE」仅为对外标识兼容，语义为累计 strike。
 * Derivation: 3 = 同 MAX_CONSECUTIVE_PARSE_ERRORS 经验值 / 短期 max_tokens 截断可能 prompt
 * 太长、累计 3 次表 prompt design 真问题需 abort 让 caller 改 / 防 token 浪费.
 */
export const MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE = 3;
