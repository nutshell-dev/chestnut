/**
 * @module L2c.Tools
 * Final ToolResult byte/line boundary. Owner-bounded previews are never
 * mistaken for complete raw output; raw overflow is persisted before preview.
 */

import * as nodePath from 'node:path';
import { formatErr, newShortUuid, truncateUtf8Prefix } from '../node-utils/index.js';
import type { ToolResult, ToolResultArtifact } from '../tool-protocol/index.js';
import type { FileSystem } from '../fs/index.js';
import { TOOL_AUDIT_EVENTS } from './audit-events.js';
import { DEFAULT_TOOL_OUTPUT_BOUNDS, TOOL_OUTPUT_ARTIFACT_ROOT } from './constants.js';
import type { ExecContext, ToolOutputBounds } from './types.js';

export interface ToolOutputWriteSide {
  readonly fs: Pick<FileSystem, 'writeAtomic'>;
  readonly baseDir: string;
  readonly syncDir: string;
  readonly workspaceDir: string;
}

/** Capture the caller output domain before a cross-claw read rebinds ctx.fs. */
export function resolveToolOutputWriteSide(ctx: ExecContext): ToolOutputWriteSide {
  return ctx.toolOutput ?? {
    fs: ctx.fs,
    baseDir: ctx.clawDir,
    syncDir: ctx.syncDir,
    workspaceDir: ctx.workspaceDir,
  };
}

interface OutputSize {
  bytes: number;
  lines: number;
}

function measure(content: string): OutputSize {
  return {
    bytes: Buffer.byteLength(content, 'utf8'),
    lines: content.split('\n').length,
  };
}

function exceedsBounds(size: OutputSize, bounds: ToolOutputBounds): boolean {
  return size.bytes > bounds.maxBytes || size.lines > bounds.maxLines;
}

function validBounds(bounds: ToolOutputBounds): boolean {
  return Number.isSafeInteger(bounds.maxBytes) && bounds.maxBytes > 0
    && Number.isSafeInteger(bounds.maxLines) && bounds.maxLines > 0
    && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(bounds.artifactKind);
}

function audit(
  ctx: ExecContext,
  toolName: string,
  stage: 'invalid-bounds' | 'owner-bounded' | 'write' | 'durability' | 'output-budget' | 'preview',
  path?: string,
  reason?: string,
): void {
  ctx.auditWriter?.write(
    TOOL_AUDIT_EVENTS.TOOL_OUTPUT_CAP,
    toolName,
    `stage=${stage}`,
    ...(path === undefined ? [] : [`path=${path}`]),
    ...(reason === undefined ? [] : [`reason=${reason}`]),
  );
}

/** Fixed errors contain no artifact path and are themselves bounded. */
function fixedFailure(message: string, bounds: ToolOutputBounds): string {
  const lineBounded = message.split('\n').slice(0, bounds.maxLines).join('\n');
  return truncateUtf8Prefix(lineBounded, bounds.maxBytes);
}

function withOutput(
  raw: ToolResult,
  content: string,
  success: boolean,
  artifact: ToolResultArtifact,
  error?: string,
): ToolResult {
  return {
    ...raw,
    success,
    content,
    ...(error === undefined ? {} : { error }),
    metadata: {
      ...raw.metadata,
      output: { ownerBounded: true, artifact },
    },
  };
}

/**
 * Keep the footer verbatim. Only the raw body prefix is byte/line bounded.
 * A one-line budget uses a space separator so the footer still fits.
 */
function fitPreview(raw: string, footer: string, bounds: ToolOutputBounds): string | null {
  const separator = bounds.maxLines === 1 ? ' ' : '\n';
  const suffix = `${separator}${footer}`;
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  if (suffixBytes > bounds.maxBytes) return null;

  const suffixLines = suffix.split('\n').length;
  const bodyLineBudget = bounds.maxLines - suffixLines + 1;
  if (bodyLineBudget < 1) return null;
  const linePrefix = raw.split('\n').slice(0, bodyLineBudget).join('\n');
  const body = truncateUtf8Prefix(linePrefix, bounds.maxBytes - suffixBytes);
  return `${body}${suffix}`;
}

function invalidBoundsResult(
  ctx: ExecContext,
  toolName: string,
  raw: ToolResult,
): ToolResult {
  const reason = 'outputBounds require positive safe-integer caps and one safe artifactKind path segment';
  audit(ctx, toolName, 'invalid-bounds', undefined, reason);
  const error = 'tool_output_bounds_invalid';
  return withOutput(
    raw,
    fixedFailure(`Tool '${toolName}' declared invalid outputBounds; output was not delivered.`, DEFAULT_TOOL_OUTPUT_BOUNDS),
    false,
    { kind: 'failed' },
    error,
  );
}

function ownerOverflowResult(
  ctx: ExecContext,
  toolName: string,
  raw: ToolResult,
  bounds: ToolOutputBounds,
  size: OutputSize,
): ToolResult {
  const artifact = raw.metadata?.output?.artifact;
  const path = artifact !== undefined && artifact.kind !== 'failed' ? artifact.path : undefined;
  const reason = `owner-bounded content is ${size.bytes} bytes/${size.lines} lines, limits ${bounds.maxBytes}/${bounds.maxLines}`;
  audit(ctx, toolName, 'owner-bounded', path, reason);
  return {
    ...raw,
    success: false,
    content: fixedFailure(
      `Tool '${toolName}' returned owner-bounded output above executor limits; refusing to persist a preview as complete output.`,
      bounds,
    ),
    error: 'owner_bounded_output_exceeds_bounds',
  };
}

/**
 * Enforce both UTF-8 bytes and lines on a completed, raw tool result.
 * Persistence failures are explicit ToolResult failures; committed artifacts
 * retain their exact writeAtomic durability state and remain retrievable.
 */
export async function enforceToolResultBounds(
  ctx: ExecContext,
  toolName: string,
  result: ToolResult,
  bounds: ToolOutputBounds,
): Promise<ToolResult> {
  if (!validBounds(bounds)) return invalidBoundsResult(ctx, toolName, result);

  const size = measure(result.content);
  if (!exceedsBounds(size, bounds)) return result;
  if (result.metadata?.output?.ownerBounded === true) {
    return ownerOverflowResult(ctx, toolName, result, bounds, size);
  }

  const writeSide = resolveToolOutputWriteSide(ctx);
  const fileName = `${newShortUuid()}.md`;
  const writePath = `${TOOL_OUTPUT_ARTIFACT_ROOT}/${bounds.artifactKind}/${fileName}`;
  const absolutePath = nodePath.join(writeSide.baseDir, writePath);
  const displayPath = nodePath.relative(writeSide.workspaceDir, absolutePath);

  let written: Awaited<ReturnType<typeof writeSide.fs.writeAtomic>>;
  try {
    // writeAtomic is baseDir-relative; syncDir is used only for display/audit.
    written = await writeSide.fs.writeAtomic(writePath, result.content);
  } catch (err) {
    const reason = formatErr(err);
    audit(ctx, toolName, 'write', displayPath, reason);
    const footer = `[tool output capped from ${size.bytes} bytes/${size.lines} lines; artifact=failed; full output was not persisted; see audit.]`;
    let content: string | null = null;
    try {
      content = fitPreview(result.content, footer, bounds);
    } catch (previewErr) {
      audit(ctx, toolName, 'preview', displayPath, formatErr(previewErr));
    }
    return withOutput(
      result,
      content ?? fixedFailure('Tool output persistence failed; full output was not saved.', bounds),
      false,
      { kind: 'failed' },
      'tool_output_artifact_persist_failed',
    );
  }

  if (written.kind !== 'durable') {
    audit(ctx, toolName, 'durability', displayPath, formatErr(written.error));
  }
  const artifact: ToolResultArtifact = { kind: written.kind, path: displayPath };
  const readCommand = `read({ "path": ${JSON.stringify(displayPath)}, "offset": 1, "limit": 200 })`;
  const footer = `[tool output capped from ${size.bytes} bytes/${size.lines} lines; full output saved at ${displayPath}; artifact=${written.kind}; retrieve with ${readCommand}.]`;
  let content: string | null = null;
  try {
    content = fitPreview(result.content, footer, bounds);
  } catch (previewErr) {
    audit(ctx, toolName, 'preview', displayPath, formatErr(previewErr));
  }
  if (content === null) {
    const reason = `complete artifact footer exceeds ${bounds.maxBytes} bytes/${bounds.maxLines} lines`;
    audit(ctx, toolName, 'output-budget', displayPath, reason);
    return withOutput(
      result,
      fixedFailure('Tool output artifact footer exceeds output bounds; see audit log for the complete path.', bounds),
      false,
      artifact,
      'tool_output_footer_exceeds_bounds',
    );
  }

  return withOutput(result, content, result.success, artifact);
}
