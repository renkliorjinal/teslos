'use strict';

/**
 * Runs the suites and says which failed.
 *
 * Each one is a separate process on its own port with its own state directory,
 * because they all start the real server in-process and a shared anything
 * between them has already cost an afternoon once.
 *
 *   npm test              everything available on this machine
 *   npm run test:fast     only the suites that need no browser
 *   node test/all.js sound resume    just those two
 */

const { spawnSync } = require('child_process');
const path = require('path');
const helpers = require('./helpers');

// Roughly cheapest first, so a broken build fails early rather than after the
// browser suites have spent five minutes proving it.
const SUITES = [
  { name: 'drift', needs: [] },
  { name: 'reaper', needs: [] },
  { name: 'resolve', needs: [] },
  { name: 'clientchain', needs: [] },
  { name: 'audioroom', needs: [] },
  { name: 'slots', needs: ['ffmpeg'] },
  { name: 'cookies', needs: ['ffmpeg'] },
  { name: 'statedir', needs: ['ffmpeg'] },
  { name: 'audio', needs: ['ffmpeg'] },
  { name: 'directpaths', needs: ['ffmpeg'] },
  { name: 'h264', needs: ['ffmpeg'] },
  { name: 'browse', needs: ['ffmpeg', 'browser'] },
  { name: 'ui', needs: ['ffmpeg', 'browser'] },
  { name: 'oauth', needs: ['ffmpeg', 'browser'] },
  { name: 'sound', needs: ['ffmpeg', 'browser'] },
  { name: 'resume', needs: ['ffmpeg', 'browser'] },
  { name: 'run', needs: ['ffmpeg', 'browser'] },
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const fastOnly = process.argv.includes('--fast');

const have = {
  ffmpeg: helpers.haveFfmpeg(),
  browser: helpers.havePlaywright(),
};

if (!have.ffmpeg) console.log('note: ffmpeg not runnable — those suites will be skipped');
if (!have.browser) console.log('note: playwright not installed — browser suites will be skipped');

const results = [];
let ran = 0;

for (const suite of SUITES) {
  if (only.length && !only.includes(suite.name)) continue;
  if (fastOnly && suite.needs.includes('browser')) continue;

  const missing = suite.needs.filter((n) => !have[n]);
  if (missing.length) {
    results.push({ name: suite.name, status: 'skipped', why: `no ${missing.join(', ')}` });
    continue;
  }

  console.log(`\n${'='.repeat(60)}\n  ${suite.name}\n${'='.repeat(60)}`);
  const started = Date.now();
  const proc = spawnSync(process.execPath, [path.join(__dirname, `${suite.name}.js`)], {
    stdio: 'inherit',
    // Long enough for the browser suites, which deliberately wait out real
    // timeouts rather than mocking them.
    timeout: 15 * 60 * 1000,
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  ran += 1;
  results.push({
    name: suite.name,
    status: proc.status === 0 ? 'passed' : 'FAILED',
    why: `${seconds}s`,
  });
}

console.log(`\n${'='.repeat(60)}`);
for (const r of results) {
  const mark = r.status === 'passed' ? 'ok  ' : r.status === 'skipped' ? '--  ' : 'FAIL';
  console.log(`  ${mark}  ${r.name.padEnd(14)} ${r.why}`);
}

const failed = results.filter((r) => r.status === 'FAILED');
console.log(failed.length
  ? `\n${failed.length} of ${ran} suite(s) failed\n`
  : `\n${ran} suite(s) passed\n`);
process.exit(failed.length ? 1 : 0);
