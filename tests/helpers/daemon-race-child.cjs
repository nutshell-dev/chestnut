/**
 * Helper child for real stop/spawning→active race tests.
 *
 * The parent prepares the generation in `status/process/spawning`, writes
 * `pid.json` with this process's PID, then starts the stop protocol. This child
 * writes `ready.json`, waits for a barrier file, moves the generation into
 * `active`, and keeps running until SIGTERM.
 */
const fs = require('fs');
const path = require('path');

const daemonDir = process.argv[2];
const generationId = process.env.CHESTNUT_PROCESS_GENERATION;

if (!daemonDir || !generationId) {
  process.stderr.write('missing daemon dir or generation id\n');
  process.exit(1);
}

const processDir = path.join(daemonDir, 'status', 'process');
const spawningDir = path.join(processDir, 'spawning');
const activeDir = path.join(processDir, 'active');
const barrierFile = path.join(processDir, 'child-go');
const pidFile = path.join(spawningDir, 'pid.json');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  // Mirror ProcessManager writeReadyFact: a reader may observe either the old
  // path state or the complete JSON record, never a partially-written file.
  const tempPath = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(obj, null, 2), { flag: 'wx' });
  fs.renameSync(tempPath, p);
}

function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    // Busy-wait; test controls timing via the barrier file.
  }
  return predicate();
}

function shutdown() {
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Wait for parent to commit this generation and write our PID.
if (!waitFor(() => fs.existsSync(pidFile))) {
  process.stderr.write('timeout waiting for pid.json\n');
  process.exit(2);
}
const pidRecord = readJson(pidFile);
if (pidRecord.generation_id !== generationId) {
  process.stderr.write('pid.json generation mismatch\n');
  process.exit(3);
}

// Write ready fact so the generation is eligible to activate.
writeJson(path.join(spawningDir, 'ready.json'), {
  schema_version: 1,
  generation_id: generationId,
  pid: process.pid,
  created_at: new Date().toISOString(),
});

// Wait for the stop protocol to reach the point where it has located us.
if (!waitFor(() => fs.existsSync(barrierFile))) {
  process.stderr.write('timeout waiting for barrier\n');
  process.exit(4);
}

// Activate: move the whole generation directory into active.
fs.renameSync(spawningDir, activeDir);

// Keep running until the stop signal arrives.
setInterval(() => {}, 1000);
