'use strict';

// Runs a node script from a test and returns its exit status plus combined output.
//
// Output is redirected to a file instead of a pipe on purpose: sandboxed environments (DSH
// workspace-write on Windows, some hardened CI agents) deny pipe creation with EPERM. A piped
// spawnSync then returns status null and no output at all, which reads as a product failure.
// File redirection keeps the same observable behaviour everywhere.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runNode(args, options = {}) {
  const logFile = path.join(os.tmpdir(), `child-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  const fd = fs.openSync(logFile, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, args, { ...options, stdio: ['ignore', fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  let output = '';
  try {
    output = fs.readFileSync(logFile, 'utf8');
  } catch { /* keep empty */ }
  try {
    fs.unlinkSync(logFile);
  } catch { /* best effort */ }
  return { status: result.status, signal: result.signal, error: result.error, output };
}

module.exports = { runNode };
