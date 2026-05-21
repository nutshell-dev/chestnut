import { defineConfig } from 'vitest/config';
import os from 'node:os';

const maxThreads = os.cpus().length;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    pool: 'threads',
    poolOptions: {
      threads: { maxThreads },
    },
    testTimeout: 15000,     // 覆盖最长等待（2500ms 重试 + IO margin）
    hookTimeout: 10000,     // beforeEach/afterEach 文件系统操作留足时间
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '**/*.d.ts',
        '**/*.config.ts'
      ]
    }
  },
});
