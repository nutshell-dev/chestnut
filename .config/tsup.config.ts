import { defineConfig } from 'tsup';

export default defineConfig([
  // Library build
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    target: 'node18',
  },
  // CLI build
  {
    entry: {
      cli: 'src/cli/index.ts',
      'daemon-entry': 'src/daemon-entry.ts',
      'watchdog-entry': 'src/watchdog-entry.ts',
    },
    format: ['esm'],
    banner: {
      js: '#!/usr/bin/env node',
    },
    sourcemap: true,
    minify: false,
    target: 'node18',
  },
]);
