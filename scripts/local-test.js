#!/usr/bin/env node
'use strict';

// Local test runner for restricted environments.
//
// `npm test` (node --test) isolates every test file in a child process and reads its output through a pipe.
// Some sandboxes (DSH workspace-write on Windows, hardened CI agents) deny that pipe with EPERM, so the
// runner fails before a single test runs. This script runs each test file directly (`node file.test.js`),
// which keeps the same node:test semantics per file without the extra process layer, then aggregates the
// counters. On a normal machine `npm test` remains the canonical command; this one is the fallback.
//
// Usage: node scripts/local-test.js [--filter <substring>]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const filterIndex = args.indexOf('--filter');
const filter = filterIndex >= 0 ? String(args[filterIndex + 1] || '') : '';

function collect(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'var' || entry.name.startsWith('.')) continue;
      collect(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      if (!filter || full.includes(filter)) out.push(full);
    }
  }
  return out;
}

function counters(output) {
  const pick = (label) => {
    const match = output.match(new RegExp(`(?:^|\\n)[^\\n]*${label} (\\d+)`));
    return match ? Number(match[1]) : 0;
  };
  return { tests: pick('tests'), pass: pick('pass'), fail: pick('fail') };
}

const files = collect(path.join(ROOT, 'test'), []).sort();
if (!files.length) {
  console.error('no test files found');
  process.exit(2);
}

const totals = { tests: 0, pass: 0, fail: 0, files: 0, failedFiles: [] };
const started = Date.now();
for (const file of files) {
  const rel = path.relative(ROOT, file);
  // Child output goes to a file, not to a pipe: some sandboxes deny pipe creation (EPERM) and then
  // spawnSync returns status null with no output at all.
  const logFile = path.join(os.tmpdir(), `local-test-${process.pid}-${Buffer.from(rel).toString('hex').slice(0, 16)}.log`);
  const fd = fs.openSync(logFile, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [file], { cwd: ROOT, timeout: 120000, stdio: ['ignore', fd, fd] });
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
  const counts = counters(output);
  totals.files += 1;
  totals.tests += counts.tests;
  totals.pass += counts.pass;
  totals.fail += counts.fail;
  if (result.status !== 0 || counts.fail > 0 || counts.tests === 0) {
    totals.failedFiles.push({ file: rel, status: result.status, counts });
    console.log(`FAIL ${rel} (exit ${result.status}, tests=${counts.tests}, pass=${counts.pass}, fail=${counts.fail})`);
    const firstError = output.split('\n').find((line) => line.includes('✖') || line.includes('AssertionError'));
    if (firstError) console.log(`     ${firstError.trim()}`);
    if (process.env.LOCAL_TEST_VERBOSE) console.log(output.split('\n').slice(-25).join('\n'));
  } else {
    console.log(`ok   ${rel} (${counts.pass}/${counts.tests})`);
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${totals.files} files, ${totals.tests} tests: ${totals.pass} pass, ${totals.fail} fail (${seconds}s)`);
if (totals.failedFiles.length) {
  console.log(`failed files: ${totals.failedFiles.map((row) => row.file).join(', ')}`);
  process.exit(1);
}
