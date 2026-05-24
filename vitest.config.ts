import { defineConfig } from 'vitest/config';
import os from 'node:os';

const maxThreads = os.cpus().length;

export default defineConfig({
  esbuild: {
    target: 'es2022', // phase 1218 γ: reduce down-leveling for faster transform
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    pool: 'threads',
    poolOptions: {
      threads: { maxThreads },
    },
    server: {
      deps: {
        // phase 1218 γ: inline common deps to reduce cross-worker re-parsing
        inline: ['chokidar'],
      },
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
