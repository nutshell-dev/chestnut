/**
 * JSONL file operations
 *
 * - appendJsonl: Append JSON record as a line (newline-delimited)
 * - readJsonl: Read and parse JSONL file (diagnostic only; see jsdoc)
 *
 * Note: Appends are safe for concurrent writes (OS-level atomicity for small writes)
 */

import { promises as fs } from 'fs';
import { appendFile } from '../fs/atomic.js';

/**
 * Append a JSON record to a JSONL file
 * @param filePath - Path to JSONL file
 * @param record - Record to append
 */
export async function appendJsonl(
  filePath: string,
  record: Record<string, unknown>
): Promise<void> {
  const line = JSON.stringify(record) + '\n';
  await appendFile(filePath, line);
}

/**
 * Read all records from a JSONL file
 *
 * @remarks Diagnostic utility — currently no production hot-path consumer.
 * Kept for ad-hoc inspection of archived JSONL logs and `appendJsonl` tests.
 *
 * @param filePath - Path to JSONL file
 * @returns Array of parsed records (skips empty lines and invalid JSON)
 */
export async function readJsonl<T = Record<string, unknown>>(
  filePath: string
): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const records: T[] = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue; // Skip empty lines
      }
      
      try {
        const record = JSON.parse(trimmed) as T;
        records.push(record);
      } catch {
        console.warn(`[monitor] Skipping invalid JSONL line: ${trimmed.slice(0, 80)}`);
        continue;
      }
    }
    
    return records;
  } catch (error) {
    // File doesn't exist - return empty array
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}


