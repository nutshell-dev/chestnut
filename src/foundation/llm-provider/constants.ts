/** Token reserve for thinking budget calculation */
export const THINKING_TOKEN_RESERVE = 1024;

/** Minimum usable output tokens after reactive max_tokens adjustment */
export const MIN_USABLE_OUTPUT_TOKENS = 100;

/** Maximum duration for a single LLM stream call (ms) - 5 minutes */
export const STREAM_MAX_DURATION_MS = 5 * 60 * 1000;

/** Maximum idle timeout for SSE stream parsers (ms) — independent from stream duration */
export const STREAM_IDLE_MAX_MS = 60_000;


