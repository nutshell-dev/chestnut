/** Cooperative cancellation boundary shared by FileTool operations. */
export function throwIfFileToolAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const detail = signal.reason === undefined ? '' : `: ${formatAbortReason(signal.reason)}`;
  const error = new Error(`File tool execution aborted${detail}`);
  error.name = 'AbortError';
  throw error;
}

export function isFileToolAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function formatAbortReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    // silent: reason formatting is diagnostic-only; JSON failure falls back to String(reason)
    return String(reason);
  }
}
