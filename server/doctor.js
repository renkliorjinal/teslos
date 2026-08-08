'use strict';

// Pre-flight check. Every failure mode below shows up in the car as a blank
// canvas, which is a miserable thing to debug from the driver's seat.

const { execFileSync } = require('child_process');
const config = require('./config');

let failures = 0;

function pass(label, detail) {
  console.log(`  ok    ${label}${detail ? '  ' + detail : ''}`);
}

function fail(label, detail) {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`);
}

function tryExec(bin, args) {
  try {
    return execFileSync(bin, args, { timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (err) {
    return null;
  }
}

console.log('\nteslos doctor\n');

// Node
const major = Number(process.versions.node.split('.')[0]);
if (major >= 18) pass('node', process.versions.node);
else fail('node', `${process.versions.node} — 18 or newer required`);

// ffmpeg
const ffmpegVersion = tryExec(config.ffmpeg, ['-version']);
if (!ffmpegVersion) {
  fail('ffmpeg', `not runnable as "${config.ffmpeg}"`);
} else {
  pass('ffmpeg', ffmpegVersion.split('\n')[0].replace('ffmpeg version ', ''));

  // The three encoders the pipeline actually shells out to.
  const encoders = tryExec(config.ffmpeg, ['-hide_banner', '-encoders']) || '';
  for (const [name, why] of [
    ['mpeg1video', 'canvas video path'],
    ['mp2', 'muxed audio path'],
    ['libmp3lame', 'fallback <audio> path'],
    ['libx264', 'probe test clip'],
  ]) {
    // Encoder lines look like " V..... mpeg1video   raw MPEG-1 video".
    const found = new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(encoders);
    if (found) pass(`ffmpeg encoder: ${name}`, why);
    else fail(`ffmpeg encoder: ${name}`, `missing — ${why} will not work`);
  }
}

// yt-dlp
const ytDlpVersion = tryExec(config.ytDlp, ['--version']);
if (ytDlpVersion) pass('yt-dlp', ytDlpVersion.trim());
else fail('yt-dlp', `not runnable as "${config.ytDlp}"`);

if (config.cookies) {
  const fs = require('fs');
  if (fs.existsSync(config.cookies)) pass('cookie jar', config.cookies);
  else fail('cookie jar', `${config.cookies} does not exist`);
} else {
  console.log('  note  no YT_DLP_COOKIES set — datacenter IPs often need one');
}

console.log('');

// A real resolve is the only check that proves the whole chain works from this
// host's IP, so it runs last and is allowed to be slow.
if (ytDlpVersion) {
  console.log('  ...  testing a real YouTube resolve against each player client');
  const youtube = require('./youtube');

  youtube.resolveStreams('aqz-KE-bpKQ', 480)
    .then(() => {
      pass('youtube resolve', `player_client=${youtube.activeClient()}`);
      finish();
    })
    .catch((err) => {
      const detail = err.message.trim().split('\n').slice(-1)[0];
      fail('youtube resolve', detail);
      if (/bot|sign in|cookies|po[_ ]?token/i.test(detail)) {
        console.log(`\n  Tried: ${youtube.CLIENT_CHAIN.join(', ')}`);
        console.log('  YouTube refused this IP on every one. Export cookies from a');
        console.log('  logged-in browser in Netscape format and point YT_DLP_COOKIES');
        console.log('  at the file. Treat it as a credential: chmod 600.');
      }
      finish();
    });
} else {
  finish();
}

function finish() {
  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}
