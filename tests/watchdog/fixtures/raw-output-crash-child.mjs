#!/usr/bin/env node
/** Phase 2153 Step B1：raw stdout/stderr 与可捕获 crash 文本 fixture。 */
process.stdout.write('watchdog-raw-stdout\n');
process.stderr.write('watchdog-raw-stderr\n');
throw new Error('watchdog-raw-uncaught');
