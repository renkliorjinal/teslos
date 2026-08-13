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

if (config.setupToken) {
  const host = process.env.TESLOS_DOMAIN || 'your-host';
  pass('setup page', `https://${host}/setup/?k=${config.setupToken}`);
  console.log('  Open that link on a computer to upload a YouTube cookie jar.');
} else {
  console.log('  note  no SETUP_TOKEN set — the /setup/ cookie page is disabled');
}

if (config.proxy) {
  // The example in .env.example is a shape, not an address, and pasting it
  // verbatim reaches yt-dlp as an unparseable URL several steps later.
  let parsedProxy = null;
  try {
    parsedProxy = new URL(config.proxy);
  } catch {
    parsedProxy = null;
  }

  if (!parsedProxy) {
    fail('proxy', `${config.maskProxy(config.proxy)} is not a valid URL`);
    console.log('  PROXY_URL still looks like the placeholder. Replace host, port');
    console.log('  and credentials with your own, e.g. http://user:pass@1.2.3.4:8080');
  } else if (/^(host|proxy|example\.com)$/i.test(parsedProxy.hostname)) {
    fail('proxy', `hostname "${parsedProxy.hostname}" is the placeholder, not a real host`);
  } else {
    pass('proxy', config.maskProxy(config.proxy));
  }
  if (config.proxyMedia && !config.proxyUsableByFfmpeg) {
    fail('proxy for media', 'ffmpeg cannot tunnel through a SOCKS proxy');
    console.log('  The resolve will succeed and the media fetch will not, because');
    console.log('  YouTube binds each media URL to the address that asked for it.');
    console.log('  Run a local HTTP-to-SOCKS bridge and point PROXY_URL at that.');
  } else if (config.proxyMedia) {
    pass('proxy for media', 'ffmpeg tunnels through it too');
  } else {
    console.log('  note  PROXY_MEDIA=0 — media is fetched directly, expect CDN 403s');
  }
} else {
  console.log('  note  no PROXY_URL set — YouTube sees this datacenter address');
}

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
