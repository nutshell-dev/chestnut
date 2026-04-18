/**
 * Monitor tests - JSONL-based event logging
 * 
 * Tests:
 * - JSONL append/read operations
 * - JsonlLogger event logging
 * - Query filtering (clawId, time range)
 * - Metrics aggregation
 * - Concurrent write safety
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { JsonlLogger } from '../../src/foundation/monitor/monitor.js';
import { appendJsonl, readJsonl } from '../../src/foundation/monitor/jsonl.js';

/**
 * Create a temporary directory for tests
 */
async function createTempDir(): Promise<string> {
  const tempDir = path.join(tmpdir(), `clawforum-monitor-test-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Clean up temporary directory
 */
async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe('Monitor', () => {
  describe('jsonl.ts', () => {
    let tempDir: string;
    
    beforeEach(async () => {
      tempDir = await createTempDir();
    });
    
    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });
    
    it('should append records to JSONL file', async () => {
      const filePath = path.join(tempDir, 'test.jsonl');
      
      await appendJsonl(filePath, { id: '1', message: 'hello' });
      await appendJsonl(filePath, { id: '2', message: 'world' });
      
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual({ id: '1', message: 'hello' });
      expect(JSON.parse(lines[1])).toEqual({ id: '2', message: 'world' });
    });
    
    it('should read records from JSONL file', async () => {
      const filePath = path.join(tempDir, 'test.jsonl');
      
      await fs.writeFile(
        filePath,
        '{"id":"1"}\n{"id":"2"}\n{"id":"3"}\n',
        'utf-8'
      );
      
      const records = await readJsonl(filePath);
      
      expect(records).toHaveLength(3);
      expect(records[0]).toEqual({ id: '1' });
      expect(records[2]).toEqual({ id: '3' });
    });
    
    it('should skip empty lines and invalid JSON', async () => {
      const filePath = path.join(tempDir, 'test.jsonl');
      
      await fs.writeFile(
        filePath,
        '{"id":"1"}\n\n{"id":"2"}\ninvalid json\n{"id":"3"}\n',
        'utf-8'
      );
      
      const records = await readJsonl(filePath);
      
      expect(records).toHaveLength(3);
      expect(records.map(r => r.id)).toEqual(['1', '2', '3']);
    });
    
    it('should return empty array for non-existent file', async () => {
      const filePath = path.join(tempDir, 'non-existent.jsonl');
      
      const records = await readJsonl(filePath);
      
      expect(records).toEqual([]);
    });
    
    it('should handle special characters in JSON', async () => {
      const filePath = path.join(tempDir, 'test.jsonl');
      const record = {
        message: 'Line 1\nLine 2\tTabbed',
        unicode: '你好 🎉',
        quote: 'He said "hello"',
      };
      
      await appendJsonl(filePath, record);
      const records = await readJsonl(filePath);
      
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual(record);
    });
    
  });
  
  describe('JsonlLogger', () => {
    let tempDir: string;
    let monitor: JsonlLogger;
    
    beforeEach(async () => {
      tempDir = await createTempDir();
      monitor = new JsonlLogger({ logsDir: tempDir });
    });
    
    afterEach(async () => {
      await monitor.close();
      await cleanupTempDir(tempDir);
    });
    
    it('should log events to monitor.jsonl', async () => {
      monitor.log('system', { action: 'startup', version: '0.1.0' });
      
      await monitor.flush();
      
      const filePath = path.join(tempDir, 'monitor.jsonl');
      const records = await readJsonl(filePath);
      
      expect(records).toHaveLength(1);
      expect(records[0].type).toBe('system');
      expect(records[0].data.action).toBe('startup');
    });
    
    it('should include clawId and contractId in logged events', async () => {
      monitor.log('contract_created', { clawId: 'claw-001', contractId: 'contract-123', title: 'Test' });
      
      await monitor.flush();
      
      const filePath = path.join(tempDir, 'monitor.jsonl');
      const records = await readJsonl(filePath);
      
      expect(records[0].clawId).toBe('claw-001');
      expect(records[0].contractId).toBe('contract-123');
      expect(records[0].data.title).toBe('Test');
    });
    
    it('should handle 100 concurrent logs without data loss', async () => {
      const logs = Array.from({ length: 100 }, (_, i) => 
        monitor.log('system', { index: i })
      );
      
      await Promise.all(logs);
      await monitor.flush();
      
      const filePath = path.join(tempDir, 'monitor.jsonl');
      const records = await readJsonl(filePath);
      
      expect(records).toHaveLength(100);
    });
  });
});
