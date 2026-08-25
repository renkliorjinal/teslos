'use strict';

/**
 * Shared plumbing for the suites, so each one says what it is testing rather
 * than where its ffmpeg lives.
 *
 * Every suite runs the real server in-process against real ffmpeg, with only
 * yt-dlp replaced by a script pointing at a local fixture. That is deliberate:
 * the bugs this project has actually had were in the seams — pacing, buffering,
 * sync, the WebSocket — and a suite that mocks the seams would have caught none
 * of them.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Generated fixtures are large and reproducible, so they live in the system
// temp directory rather than the repository. They are cached between runs
// because building the incompressible clip takes a few seconds.
const FIXTURES = path.join(os.tmpdir(), 'teslos-test-fixtures');
fs.mkdirSync(FIXTURES, { recursive: true });

const ffmpeg = process.env.FFMPEG || 'ffmpeg';

function haveFfmpeg() {
  try {
    execFileSync(ffmpeg, ['-version'], { stdio: 'ignore', timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- reporting

function reporter() {
  let failures = 0;
  return {
    check(label, ok, detail) {
      console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
      if (!ok) failures += 1;
    },
    note(text) {
      console.log(`       ${text}`);
    },
    done(name) {
      console.log(failures ? `\n${failures} FAILED in ${name}\n` : `\n${name}: all passed\n`);
      process.exit(failures ? 1 : 0);
    },
    get failures() {
      return failures;
    },
  };
}

// ------------------------------------------------------------------- server
//
// Each suite gets its own port and its own state directory. Sharing either one
// let a suite's watch history leak into another's assertions, which is a
// miserable way to spend an afternoon.

function isolate(name, port) {
  const stateDir = path.join(os.tmpdir(), `teslos-test-${name}`);
  fs.rmSync(stateDir, { recursive: true, force: true });

  process.env.PORT = String(port);
  process.env.BIND = '127.0.0.1';
  process.env.STATE_DIRECTORY = stateDir;
  // A path that will never exist, so "no cookie jar" is the default and a suite
  // that wants one creates it deliberately.
  process.env.YT_DLP_COOKIES = path.join(stateDir, 'no-such-jar.txt');

  return {
    stateDir,
    base: `http://127.0.0.1:${port}`,
    cleanup() {
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

async function startServer() {
  require(path.join(ROOT, 'server', 'index.js'));
  await new Promise((r) => setTimeout(r, 700));
}

// --------------------------------------------------------------- yt-dlp stub
//
// The one thing that cannot be real: resolving a YouTube URL needs the network,
// an unblocked address, and a video that still exists. Everything downstream of
// it — ffmpeg, the transport, the player — runs for real against the URL this
// hands back.

function fakeYtDlp({ url, id = 'dQw4w9WgXcQ', title = 'Test klip', duration = 120,
  uploader = 'Kanal', countFile = null }) {
  const file = path.join(FIXTURES, `yt-dlp-${id}-${Math.random().toString(36).slice(2, 8)}`);
  const count = countFile ? `echo x >> ${JSON.stringify(countFile)}\n` : '';
  fs.writeFileSync(file, `#!/usr/bin/env bash
${count}for a in "$@"; do case "$a" in -g) echo ${JSON.stringify(url)}; exit 0 ;; esac; done
echo '{"id":"${id}","title":"${title}","duration":${duration},"is_live":false,"uploader":"${uploader}","thumbnail":""}'
`, { mode: 0o755 });
  process.env.YT_DLP = file;
  return file;
}

// ------------------------------------------------------------------ fixtures

// A plain test pattern with a tone. Compresses to a fraction of the bitrate
// cap, which is fine for anything not measuring buffer behaviour.
function toneClip(seconds = 120) {
  const file = path.join(FIXTURES, `tone-${seconds}.mp4`);
  if (fs.existsSync(file)) return file;
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=15:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    // The index has to be at the front, and the fixture server has to honour
    // Range, or ffmpeg cannot read the moov box and decodes nothing at all.
    '-movflags', '+faststart', file,
  ], { timeout: 180000 });
  return file;
}

// Deliberately incompressible, for anything that depends on the client's
// fixed-byte buffer holding a realistic number of seconds. A smooth pattern
// transcodes so small that the buffer would hold minutes of it.
function noiseClip(seconds = 400) {
  const file = path.join(FIXTURES, `noise-${seconds}.mp4`);
  if (fs.existsSync(file)) return file;
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=15:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-vf', 'noise=alls=60:allf=t+u',
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-movflags', '+faststart', file,
  ], { timeout: 300000 });
  return file;
}

/**
 * Serves a fixture over HTTP, because resolveStreams only accepts http(s) URLs
 * — a media URL is what yt-dlp returns.
 *
 * Range support is not optional: an MP4's index sits at the front only if
 * +faststart was used, and ffmpeg still issues ranged requests. A server that
 * answers every one from byte zero hands it garbage, and the symptom is an
 * empty stream rather than an error.
 *
 * `stop()` destroys sockets and refuses new ones, which is how a suite
 * simulates the link going away mid-video.
 */
function serveFile(file, port) {
  const size = fs.statSync(file).size;
  let serving = true;
  const sockets = new Set();

  const server = require('http').createServer((req, res) => {
    sockets.add(res.socket);
    res.socket.on('close', () => sockets.delete(res.socket));
    if (!serving) {
      res.socket.destroy();
      return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    const start = range && range[1] ? Number(range[1]) : 0;
    const end = range && range[2] ? Number(range[2]) : size - 1;
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    const body = fs.createReadStream(file, { start, end });
    body.on('error', () => res.destroy());
    res.on('close', () => body.destroy());
    body.pipe(res);
  });
  server.listen(port, '127.0.0.1');

  return {
    url: `http://127.0.0.1:${port}/clip.mp4`,
    stop() {
      serving = false;
      for (const s of sockets) s.destroy();
    },
    start() {
      serving = true;
    },
    close() {
      server.close();
    },
  };
}

// ------------------------------------------------------------------- browser

function havePlaywright() {
  try {
    require.resolve('playwright');
    return true;
  } catch {
    return false;
  }
}

async function launchBrowser(extraArgs = []) {
  const { chromium } = require('playwright');
  const args = ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    ...extraArgs];
  // Playwright finds its own browser unless this box keeps one elsewhere.
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM || undefined;
  return chromium.launch({ executablePath, args });
}

// The car's viewport, so layout assertions mean something.
const CAR_VIEWPORT = { width: 1180, height: 919 };
const CAR_SCREEN = { width: 1900, height: 1080 };

module.exports = {
  ROOT, FIXTURES, ffmpeg, haveFfmpeg, havePlaywright,
  reporter, isolate, startServer, fakeYtDlp,
  toneClip, noiseClip, serveFile, launchBrowser,
  CAR_VIEWPORT, CAR_SCREEN,
};
