/**
 * DialogStore 资源命名空间 const (M#3 single owner)
 *
 * Previously in foundation/paths.ts — moved to canonical module owner.
 */
export const DIALOG_DIR = 'dialog' as const;
export const DIALOG_ARCHIVE_DIR = 'dialog/archive';
/**
 * Active session 文件名 in DialogStore (per-claw 当前对话).
 * phase 395: 抽 14 site inline 'current.json' literal 为 const (M#1 + ML#9)。
 */
export const CURRENT_DIALOG_FILE = 'current.json' as const;
