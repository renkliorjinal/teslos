'use strict';

/**
 * End-to-end check of the real teslos code path with YouTube swapped out.
 *
 * Exercises: ffmpeg MPEG1-TS args -> WebSocket -> JSMpeg decode -> canvas paint,
 * plus the probe fixtures and the speedtest socket. YouTube itself is
 * unreachable from this sandbox, so resolveStreams is pointed at a locally
 * served test clip; everything downstream of that is production code.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const PROJECT = require('path').join(__dirname,'..');
const helpers = require('./helpers');
const FFMPEG = helpers.ffmpeg;
// Built on first run and cached in the system temp directory; too large to
// keep in the repository and reproducible in a few seconds.
const CLIP = helpers.toneClip(40);
const FIXTURE_PORT = 8911;

process.env.FFMPEG = FFMPEG;
process.env.PORT='8742';
// Its own state directory: a shared one let one suite's history leak
// into another's assertions.
process.env.STATE_DIRECTORY=require('path').join(require('os').tmpdir(),'teslos-test-run');
require('fs').rmSync(process.env.STATE_DIRECTORY,{recursive:true,force:true});
process.env.BIND = '127.0.0.1';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

function makeClip() {
  if (fs.existsSync(CLIP)) return;
  console.log('  ...  generating test clip');
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=40',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', CLIP,
  ], { stdio: 'inherit' });
}

// Serves the clip over HTTP so the production input path (with its http-only
// reconnect flags) is the one under test.
function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const stat = fs.statSync(CLIP);
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : stat.size - 1;
        res.writeHead(206, {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(CLIP, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(CLIP).pipe(res);
    });
    server.listen(FIXTURE_PORT, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  makeClip();
  const fixture = await startFixtureServer();

  // Patch the YouTube layer before the server wires itself up. stream.js looks
  // properties up on this same module object at call time.
  const youtube = require(path.join(PROJECT, 'server', 'youtube.js'));
  const CLIP_URL = `http://127.0.0.1:${FIXTURE_PORT}/clip.mp4`;
  youtube.resolveStreams = async () => ({ video: CLIP_URL, audio: null });
  youtube.getMetadata = async (videoId) => ({
    videoId, title: 'E2E test clip', duration: 40, isLive: false, uploader: 'lavfi', thumbnail: '',
  });

  require(path.join(PROJECT, 'server', 'index.js'));
  await new Promise((r) => setTimeout(r, 700));

  const base = 'http://127.0.0.1:8742';

  // ---- HTTP surface ----
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  check('/api/health', health.ok === true, `sessions=${health.sessions} default=${health.defaultQuality}p`);

  const meta = await fetch(`${base}/api/meta?v=dQw4w9WgXcQ`).then((r) => r.json());
  check('/api/meta', meta.ok === true && meta.duration === 40, `duration=${meta.duration}`);

  const badMeta = await fetch(`${base}/api/meta?v=https%3A%2F%2Fexample.com%2Fnope`).then((r) => r.json());
  check('/api/meta rejects non-YouTube URL', badMeta.ok === false, badMeta.error);

  const clipRes = await fetch(`${base}/api/testclip.mp4`);
  const clipBytes = (await clipRes.arrayBuffer()).byteLength;
  check('/api/testclip.mp4', clipRes.ok && clipBytes > 5000, `${clipBytes} bytes`);

  const toneRes = await fetch(`${base}/api/testtone.mp3`);
  const toneBuf = Buffer.from(await toneRes.arrayBuffer());
  // MP3 frame sync: 0xFF followed by 0xEx/0xFx.
  const hasSync = toneBuf.length > 5000 && toneBuf.indexOf(Buffer.from([0xff, 0xfb])) !== -1;
  check('/api/testtone.mp3', toneRes.ok && hasSync, `${toneBuf.length} bytes`);

  const audioRes = await fetch(`${base}/api/audio?v=dQw4w9WgXcQ&t=5`);
  const audioChunk = await readSome(audioRes, 40000);
  check('/api/audio (fallback path)', audioChunk > 10000, `${audioChunk} bytes in 4s`);

  // ---- browser: the real decode chain ----
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required',
           '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1900, height: 1080 } });

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return;
    pageErrors.push('console: ' + m.text());
  });

  // The bare hostname is the player now, and arriving by link waits for a tap
  // rather than starting silently — so the test has to tap, like a driver would.
  await page.goto(`${base}/?v=dQw4w9WgXcQ`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tapStart.on', { timeout: 15000 });
  const tapTitle = await page.evaluate(() => document.getElementById('tapTitle').textContent);
  check('link arrival waits for a tap', tapTitle.length > 0, `"${tapTitle}"`);
  await page.click('#tapBtn');
  await page.waitForTimeout(12000);

  // Reads the composited result rather than the element: the canvas is WebGL
  // with preserveDrawingBuffer:false, so copying it from another context
  // returns a cleared buffer. A screenshot is what the driver actually sees.
  async function litPixels(selector) {
    const b64 = (await page.locator(selector).screenshot()).toString('base64');
    return page.evaluate(async (data) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + data; });
      const c = document.createElement('canvas');
      c.width = 96; c.height = 54;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      const colours = new Set();
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 24 || d[i+1] > 24 || d[i+2] > 24) lit++;
        colours.add(`${d[i] >> 5},${d[i+1] >> 5},${d[i+2] >> 5}`);
      }
      return { lit, total: c.width * c.height, colours: colours.size };
    }, b64);
  }

  // ---- direct transport ----
  //
  // Playwright's Chromium is an open-source build with no H.264 or AAC, so it
  // cannot decode — or even demux — what the direct path serves. That makes
  // two things testable here: that the server produces a correct remux, and
  // that the player notices it cannot be played and moves to the canvas path.
  // Rendering the direct picture can only be verified in the car.
  const streamRes = await fetch(`${base}/api/stream?v=dQw4w9WgXcQ&q=480&t=0`);
  const streamBytes = Buffer.from(await readSomeBuffer(streamRes, 6000));
  const remuxPath = path.join(helpers.FIXTURES, 'remuxed.mp4');
  fs.writeFileSync(remuxPath, streamBytes);
  // ffmpeg with no output file exits non-zero after printing the stream table,
  // which is exactly the information wanted here.
  const probe = require('child_process')
    .spawnSync(FFMPEG, ['-hide_banner', '-i', remuxPath], { encoding: 'utf8' }).stderr;

  check('/api/stream serves a valid MP4',
    streamRes.headers.get('content-type') === 'video/mp4' && streamBytes.length > 100000,
    `${streamBytes.length} bytes`);
  check('/api/stream copies H.264 without re-encoding', /Video: h264/.test(probe),
    (probe.match(/Video: [^,]+/) || ['?'])[0]);
  check('/api/stream copies AAC audio', /Audio: aac/.test(probe),
    (probe.match(/Audio: [^,]+/) || ['?'])[0]);
  check('/api/stream output is fragmented', /major_brand\s*:\s*iso5/.test(probe),
    (probe.match(/major_brand\s*:\s*\S+/) || ['?'])[0]);

  const boot = await page.evaluate(() => ({
    transport: document.getElementById('transportBtn').textContent,
    overlayHidden: document.getElementById('overlay').classList.contains('hidden'),
  }));
  check('overlay dismissed after load', boot.overlayHidden === true);
  // Canvas is the default because it is the transport that survives Drive.
  check('canvas transport is the default', /canvas/.test(boot.transport), boot.transport);

  // Switching to direct here must bounce straight back: this Chromium presents
  // no frames for H.264, which is the same signal the car gives under lockout.
  await page.evaluate(() => document.getElementById('transportBtn').click());
  await page.waitForTimeout(13000);
  const bounced = await page.evaluate(() => document.getElementById('transportBtn').textContent);
  check('direct with no presented frames falls back to canvas', /canvas/.test(bounced), bounced);

  // The diagnostics panel is the whole point of this build: it has to show the
  // element's real state, and it has to appear by itself when playback stalls.
  // This Chromium cannot decode H.264, so the direct path stalls for real here.
  const diag = await page.evaluate(() => {
    document.getElementById('diagBtn').click();
    return {
      visible: document.getElementById('diag').classList.contains('on'),
      text: document.getElementById('diag').textContent,
    };
  });
  check('diagnostics panel opens', diag.visible === true);
  check('diagnostics report the element state',
    /readyState|jsmpeg time/.test(diag.text) && /transport/.test(diag.text),
    diag.text.split('\n').slice(0, 3).join(' | '));
  await page.evaluate(() => document.getElementById('diagBtn').click());

  // ---- canvas transport ----
  const canvasMode = await page.evaluate(() => {
    const v = document.getElementById('direct');
    const c = document.getElementById('screen');
    const rect = c.getBoundingClientRect();
    return {
      canvasVisible: !c.classList.contains('off'),
      videoHidden: v.classList.contains('off'),
      buffer: c.width + 'x' + c.height,
      rendered: Math.round(rect.width) + 'x' + Math.round(rect.height),
      status: document.getElementById('status').textContent,
      time: document.getElementById('time').textContent,
      audioChipShown: getComputedStyle(document.getElementById('audioBtn')).display !== 'none',
    };
  });
  check('canvas transport swaps the elements', canvasMode.canvasVisible && canvasMode.videoHidden);
  check('canvas buffer matches quality preset', canvasMode.buffer === '854x480', canvasMode.buffer);
  check('canvas scaled up to fill screen', canvasMode.rendered === '1900x1080', canvasMode.rendered);
  check('audio-path chip appears only on canvas', canvasMode.audioChipShown === true);
  check('canvas stream reported as flowing', /akıyor|tampon/.test(canvasMode.status), canvasMode.status);
  check('seek bar advancing', /0:0[1-9]|0:[1-9]\d/.test(canvasMode.time), canvasMode.time);

  const b64 = (await page.locator('#screen').screenshot()).toString('base64');
  const canvasPixels = await page.evaluate(async (data) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + data; });
    const c = document.createElement('canvas');
    c.width = 96; c.height = 54;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    const colours = new Set();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 24 || d[i+1] > 24 || d[i+2] > 24) lit++;
      colours.add(`${d[i] >> 5},${d[i+1] >> 5},${d[i+2] >> 5}`);
    }
    return { lit, total: c.width * c.height, colours: colours.size };
  }, b64);
  check('JSMpeg painted real frames', canvasPixels.lit > 500 && canvasPixels.colours > 4,
    `${canvasPixels.lit}/${canvasPixels.total} lit, ${canvasPixels.colours} colours`);

  // Silence with no gesture is a browser rule, not a car one. The player must
  // say so rather than blaming WebAudio and swapping to a path that is just as
  // silent for the same reason.
  // The watchdog runs in two stages, 4s apart, and unlocks once more in
  // between. Wait past both: a real tap happened, so the muxed path must
  // survive rather than being written off and swapped for the drifting one.
  await page.waitForTimeout(9000);
  const audioHint = await page.evaluate(() => ({
    toast: document.getElementById('toast').style.display === 'none'
      ? '' : document.getElementById('toast').textContent,
    mode: document.getElementById('audioBtn').textContent,
  }));
  check('muxed audio survives the watchdog after a real tap',
    /muxed/.test(audioHint.mode), audioHint.mode);
  check('no spurious WebAudio complaint',
    !/WebAudio susturuldu|Ses başlatılamadı/.test(audioHint.toast),
    audioHint.toast || '(no toast)');

  // ---- seek restarts the canvas socket at a new offset ----
  await page.evaluate(() => {
    const bar = document.getElementById('seek');
    const r = bar.getBoundingClientRect();
    const o = { bubbles: true, clientX: r.left + r.width * 0.5, clientY: r.top + r.height / 2, pointerId: 1 };
    bar.dispatchEvent(new PointerEvent('pointerdown', o));
    bar.dispatchEvent(new PointerEvent('pointerup', o));
  });
  await page.waitForTimeout(7000);
  const afterSeek = await page.evaluate(() => document.getElementById('time').textContent);
  const secs = (afterSeek.match(/^(\d+):(\d+)/) || []).slice(1).reduce((m, x, i) => i === 0 ? Number(x) * 60 : m + Number(x), 0);
  check('seek jumped forward', secs >= 19, `now at ${afterSeek}`);

  // ---- a server-side refusal must reach the driver ----
  //
  // A <video> element reports every failure as NotSupportedError, so without
  // the body being read back the driver would see that instead of "YouTube
  // refused this server", and go looking at the wrong thing entirely.
  const realResolve = youtube.resolveStreams;
  youtube.resolveStreams = async () => {
    throw new Error('YouTube bu sunucuyu bot sanıyor; hiçbir istemci geçemedi.');
  };

  await page.evaluate(() => {
    const b = document.getElementById('transportBtn');
    if (!/doğrudan/.test(b.textContent)) b.click();
  });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    document.getElementById('libBtn').click();
    document.getElementById('q').value = 'dQw4w9WgXcQ';
    document.getElementById('go').click();
  });
  await page.waitForTimeout(4000);

  const refusal = await page.evaluate(() => ({
    toast: document.getElementById('toast').textContent,
    visible: getComputedStyle(document.getElementById('toast')).display !== 'none',
    transport: document.getElementById('transportBtn').textContent,
  }));
  check('server refusal reaches the driver verbatim',
    /bot sanıyor/.test(refusal.toast) && refusal.visible,
    `toast="${refusal.toast}"`);
  check('server refusal does not pointlessly switch transport',
    /doğrudan/.test(refusal.transport), refusal.transport);

  // A blocked server is not a blocked car: it reaches YouTube from a mobile
  // address, and current firmware lets <video> play. Offer that rather than
  // leaving a dead end.
  const escape = await page.evaluate(() => {
    const a = document.querySelector('#toast a');
    return a ? { text: a.textContent, href: a.getAttribute('href') } : null;
  });
  check('bot refusal offers YouTube directly',
    Boolean(escape) && /youtube\.com\/watch\?v=dQw4w9WgXcQ/.test(escape.href),
    escape ? `${escape.text} -> ${escape.href}` : 'no link offered');

  youtube.resolveStreams = realResolve;

  // ---- speedtest socket ----
  const speed = await page.evaluate(() => new Promise((resolve) => {
    const ws = new WebSocket('ws://' + location.host + '/ws/speedtest');
    ws.binaryType = 'arraybuffer';
    let bytes = 0; const t0 = performance.now();
    ws.onmessage = (e) => { bytes += e.data.byteLength; };
    ws.onclose = () => resolve({ bytes, mbps: (bytes * 8) / ((performance.now() - t0) / 1000) / 1e6 });
    setTimeout(() => { try { ws.close(); } catch (e) {} }, 7000);
  }));
  check('/ws/speedtest streams data', speed.bytes > 1e6, `${(speed.bytes / 1048576).toFixed(1)} MB, ${speed.mbps.toFixed(0)} Mbit/s loopback`);

  // ---- capacity guard ----
  const capacity = await page.evaluate(() => new Promise((resolve) => {
    // MAX_SESSIONS defaults to 2 and the player already holds one.
    const sockets = [];
    let refusal = null;
    for (let i = 0; i < 4; i++) {
      const ws = new WebSocket('ws://' + location.host + '/ws/video?v=dQw4w9WgXcQ&q=360&t=0');
      ws.onclose = (e) => { if (e.code === 4001 && !refusal) refusal = e.reason; };
      sockets.push(ws);
    }
    setTimeout(() => { sockets.forEach((s) => { try { s.close(); } catch (e) {} }); resolve(refusal); }, 6000);
  }));
  check('capacity limit refuses extra sessions', typeof capacity === 'string', `reason="${capacity}"`);

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  // ---- probe page ----
  // Geolocation is granted and then moved, so the speed panel is exercised for
  // real. setGeolocation leaves coords.speed null, which also puts the derived
  // haversine path under test rather than the easy branch.
  const probeCtx = await browser.newContext({
    viewport: { width: 1900, height: 1080 },
    permissions: ['geolocation'],
    geolocation: { latitude: 41.0, longitude: 29.0 },
  });
  const probePage = await probeCtx.newPage();
  const probeErrors = [];
  probePage.on('pageerror', (e) => probeErrors.push(e.message));
  await probePage.goto(`${base}/probe/`, { waitUntil: 'domcontentloaded' });
  await probePage.waitForTimeout(10000);
  const probeState = await probePage.evaluate(() => ({
    frames: Number(document.getElementById('cvCount').textContent),
    fps: document.getElementById('cvFps').textContent,
    videoPaused: document.getElementById('vidPaused').textContent,
    videoDrawable: document.getElementById('vidDraw').textContent,
    apiRows: document.getElementById('apis').children.length,
    codecRows: document.getElementById('codecs').children.length,
  }));
  check('probe canvas animating', probeState.frames > 30, `${probeState.frames} frames @ ${probeState.fps} fps`);
  check('probe <video> test live', /true|false/.test(probeState.videoPaused),
    `paused=${probeState.videoPaused} drawable=${probeState.videoDrawable}`);
  check('probe tables populated', probeState.apiRows > 20 && probeState.codecRows > 8,
    `${probeState.apiRows} apis / ${probeState.codecRows} codecs`);
  check('probe has no page errors', probeErrors.length === 0, probeErrors.slice(0, 2).join(' | '));

  const reportPosted = await probePage.evaluate(async () => {
    const res = await fetch('/api/probe-report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ e2e: true }),
    });
    return res.ok;
  });

  // ---- WebCodecs panel ----
  const wc = await probePage.evaluate(() => {
    const c = document.getElementById('wcCanvas');
    const probe = document.createElement('canvas');
    probe.width = 64; probe.height = 36;
    const ctx = probe.getContext('2d');
    let lit = 0;
    try {
      ctx.drawImage(c, 0, 0, 64, 36);
      const d = ctx.getImageData(0, 0, 64, 36).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 24 || d[i+1] > 24 || d[i+2] > 24) lit++;
    } catch (e) { /* unreadable */ }
    return {
      frames: Number(document.getElementById('wcFrames').textContent) || 0,
      fps: document.getElementById('wcFps').textContent,
      codec: document.getElementById('wcCodec').textContent,
      state: document.getElementById('wcState').textContent,
      lit,
    };
  });
  // This Chromium has no licensed codecs, so falling through to VP8 is the
  // correct result here and proves the candidate chain works.
  check('probe WebCodecs decoded frames', wc.frames > 30 && wc.lit > 200,
    `${wc.frames} frames @ ${wc.fps} fps, codec=${wc.codec}, ${wc.lit}/2304 lit`);
  check('probe WebCodecs picked a supported codec', wc.state === 'çözülüyor', wc.state);


  const auto = await probePage.evaluate(() => {
    const b = document.getElementById('btnAuto');
    const before = b.textContent;
    b.click();
    const on = b.textContent;
    b.click();
    return { before, on, off: b.textContent };
  });
  check('probe auto-report toggles', /AÇIK/.test(auto.on) && /KAPALI/.test(auto.off),
    `${auto.before} -> ${auto.on} -> ${auto.off}`);


  // The monitors arm on the first gesture, which the auto-report click above
  // already provided; give them a couple of ticks to sample the clocks.
  await probePage.waitForTimeout(3500);
  const audio = await probePage.evaluate(() => ({
    ac: document.getElementById('acState').textContent,
    el: document.getElementById('auPaused').textContent,
  }));
  check('probe audio monitors run without a button press',
    /saat işliyor/.test(audio.ac) && /ilerliyor/.test(audio.el),
    `AudioContext="${audio.ac}"  <audio>="${audio.el}"`);


  // ~200 m every 700 ms is roughly 1000 km/h; only the "clearly moving" branch
  // matters here, not the plausibility of the number.
  for (let i = 1; i <= 4; i++) {
    await probeCtx.setGeolocation({ latitude: 41.0 + i * 0.0018, longitude: 29.0 });
    await probePage.waitForTimeout(700);
  }
  const gps = await probePage.evaluate(() => ({
    now: document.getElementById('spdNow').textContent,
    state: document.getElementById('spdState').textContent,
    verdict: document.getElementById('spdVerdict').textContent,
  }));
  check('probe reads GPS speed', /km\/s/.test(gps.now) && gps.state === 'izin verildi',
    `${gps.now} — ${gps.state}`);
  check('probe calls movement a drive sample', /sürüş sayılır/.test(gps.verdict), gps.verdict);

  check('probe report accepted', reportPosted === true);

  await browser.close();
  fixture.close();

  console.log(failures === 0 ? '\nE2E: all checks passed\n' : `\nE2E: ${failures} failure(s)\n`);
  process.exit(failures === 0 ? 0 : 1);
}


async function readSomeBuffer(res, ms) {
  const reader = res.body.getReader();
  const parts = [];
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ done: true }), stop - Date.now())),
    ]);
    if (done) break;
    parts.push(Buffer.from(value));
  }
  try { await reader.cancel(); } catch (e) { /* already gone */ }
  return Buffer.concat(parts);
}

async function readSome(res, ms) {
  const reader = res.body.getReader();
  let total = 0;
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ done: true }), stop - Date.now())),
    ]);
    if (done) break;
    total += value.length;
  }
  try { await reader.cancel(); } catch (e) { /* stream already gone */ }
  return total;
}

main().catch((err) => { console.error(err); process.exit(1); });
