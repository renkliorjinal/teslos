'use strict';
// The WebCodecs transport: YouTube's own H.264, copied rather than re-encoded,
// decoded in the page and painted into a canvas with no <video> element
// anywhere. The claim that matters is that it costs the server nothing and
// still puts real pixels on screen.
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');

const { base } = helpers.isolate('h264', 8817);
const rep = helpers.reporter();

const CLIP = helpers.toneClip(60);
const fixture = helpers.serveFile(CLIP, 8918);
helpers.fakeYtDlp({ url: fixture.url, duration: 60 });

(async () => {
  await helpers.startServer();

  // -------------------------------------------------------------- the stream
  //
  // Stream-copy is the whole point: if this ever starts transcoding, the
  // server is back to spending a core per viewer and the change was pointless.
  const response = await fetch(`${base}/api/h264?v=dQw4w9WgXcQ&q=480&t=0`);
  rep.check('the endpoint answers', response.status === 200,
    `${response.status} ${response.headers.get('content-type')}`);
  rep.check('as raw H.264, not a container',
    response.headers.get('content-type') === 'video/h264');

  const reader = response.body.getReader();
  let bytes = 0;
  let delimiters = 0;
  let sps = 0;
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    for (let i = 0; i < value.length - 4; i++) {
      if (value[i] !== 0 || value[i + 1] !== 0) continue;
      const type = value[i + 2] === 1 ? value[i + 3] & 0x1f
        : (value[i + 2] === 0 && value[i + 3] === 1 ? value[i + 4] & 0x1f : -1);
      if (type === 9) delimiters += 1;
      if (type === 7) sps += 1;
    }
  }
  reader.cancel();

  rep.check('frames are delimited so the client can split them',
    delimiters > 50, `${delimiters} access unit delimiters in ${Math.round(bytes / 1024)} KB`);
  rep.check('the stream carries its own parameter sets',
    sps > 0, `${sps} SPS`);

  // The codec string the client derives has to describe this stream, and that
  // is checkable without a decoder — which matters, because some Chromium
  // builds ship none. Same arithmetic the player does.
  const head = new Uint8Array(await (await fetch(
    `${base}/api/h264?v=dQw4w9WgXcQ&q=480&t=0`)).arrayBuffer().catch(() => new ArrayBuffer(0)));
  let codec = null;
  for (let i = 0; i < Math.min(head.length, 200000) - 8; i++) {
    if (head[i] !== 0 || head[i + 1] !== 0) continue;
    const three = head[i + 2] === 1;
    const four = !three && head[i + 2] === 0 && head[i + 3] === 1;
    if (!three && !four) continue;
    const n = i + (three ? 3 : 4);
    if ((head[n] & 0x1f) !== 7) continue;
    const hex = (v) => (v < 16 ? '0' : '') + v.toString(16);
    codec = 'avc1.' + hex(head[n + 1]) + hex(head[n + 2]) + hex(head[n + 3]);
    break;
  }
  rep.check('a codec string can be read out of the SPS',
    /^avc1\.[0-9a-f]{6}$/.test(codec || ''), String(codec));

  // Roughly a third of MPEG1's allowance for the same picture, which is the
  // other half of the reason for this path.
  const kbits = Math.round((bytes * 8) / 6 / 1000);
  rep.note(`${kbits} kbit/s against a 1000 kbit/s MPEG1 preset at 480p`);

  // -------------------------------------------------------------- the player
  if (!helpers.havePlaywright()) {
    fixture.close();
    return rep.done('h264');
  }

  const browser = await helpers.launchBrowser(['--autoplay-policy=no-user-gesture-required']);
  const page = await browser.newPage({ viewport: helpers.CAR_VIEWPORT });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const hasCodecs = await page.evaluate(() => typeof VideoDecoder !== 'undefined');
  rep.check('this browser has WebCodecs at all', hasCodecs);

  // Having WebCodecs is not having H.264: Chromium built without the licensed
  // codecs has the API and none of the profiles. The car has both — 231 fps
  // measured — so the decode assertions below are skipped rather than failed
  // where they cannot mean anything.
  const canDecode = hasCodecs && await page.evaluate((c) =>
    VideoDecoder.isConfigSupported({ codec: c }).then((s) => s.supported).catch(() => false),
  codec);
  rep.note(canDecode
    ? `H.264 available here (${codec}) — decoding will be checked`
    : `no H.264 in this build — checking the fallback instead of the decode`);

  await page.evaluate(() => {
    document.getElementById('q').value = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    document.getElementById('go').click();
  });
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    if (document.getElementById('tapStart').classList.contains('on')) {
      document.getElementById('tapBtn').click();
    }
  });
  await page.waitForTimeout(2000);

  // The button must never offer a path the browser cannot take. Watching the
  // label is not enough — where H.264 is unsupported the fallback reverts it
  // within a frame — so what is counted is whether the path was attempted.
  let attempts = 0;
  page.on('request', (r) => { if (r.url().includes('/api/h264')) attempts += 1; });

  const cycle = [];
  for (let i = 0; i < 3; i++) {
    cycle.push(await page.evaluate(() => document.getElementById('transportBtn').textContent));
    await page.evaluate(() => document.getElementById('transportBtn').click());
    await page.waitForTimeout(1500);
  }
  rep.check('cycling reaches the H.264 path exactly where WebCodecs exists',
    hasCodecs ? attempts > 0 : attempts === 0,
    `${attempts} attempt(s); labels ${cycle.join(' → ')}`);

  if (canDecode) {
    // Land on H.264 deliberately rather than wherever the cycling stopped.
    await page.evaluate(() => {
      for (let i = 0; i < 4; i++) {
        if (/H\.264/.test(document.getElementById('transportBtn').textContent)) return;
        document.getElementById('transportBtn').click();
      }
    });
    await page.waitForTimeout(12000);

    const live = await page.evaluate(() => {
      document.getElementById('diagBtn').click();
      const text = document.getElementById('diag').textContent;
      document.getElementById('diagBtn').click();
      const canvas = document.getElementById('wcscreen');
      return {
        diag: text,
        visible: !canvas.classList.contains('off'),
        mpegVisible: !document.getElementById('screen').classList.contains('off'),
        videoVisible: !document.getElementById('direct').classList.contains('off'),
        width: canvas.width,
        height: canvas.height,
      };
    });

    const shown = Number((live.diag.match(/frames +(\d+) shown/) || [0, 0])[1]);
    rep.check('frames are decoded and painted', shown > 30, `${shown} shown`);
    rep.check('at the clip\'s real size', live.width >= 320 && live.height >= 180,
      `${live.width}x${live.height}`);
    rep.check('on its own canvas, with the others hidden',
      live.visible && !live.mpegVisible && !live.videoVisible,
      `wc=${live.visible} mpeg=${live.mpegVisible} video=${live.videoVisible}`);
    rep.check('the codec came from the stream, not a guess',
      /codec +avc1\./.test(live.diag), (live.diag.match(/codec.*/) || [''])[0].trim());

    // The picture is slaved to the soundtrack here exactly as on the MPEG1
    // path; without that it would race through the buffer at display rate.
    const sync = Number((live.diag.match(/sync +(-?[\d.]+)s/) || [0, 0])[1]);
    rep.check('the picture stays locked to the sound', Math.abs(sync) < 2,
      (live.diag.match(/sync.*/) || [''])[0].trim());

    // Not reading the body is the only brake on this path, so the queue must
    // settle rather than climb.
    const queued = Number((live.diag.match(/queued +(\d+)/) || [0, 0])[1]);
    rep.check('the buffer is held, not left to grow', queued <= 150, `${queued} units`);

    // Pixels, not just counters: a canvas can report frames and show black.
    const lit = await page.evaluate(() => {
      const c = document.getElementById('wcscreen');
      const probe = document.createElement('canvas');
      probe.width = 64; probe.height = 36;
      const g = probe.getContext('2d');
      g.drawImage(c, 0, 0, 64, 36);
      const d = g.getImageData(0, 0, 64, 36).data;
      let bright = 0;
      const colours = new Set();
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i + 1] + d[i + 2] > 60) bright += 1;
        colours.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
      }
      return { bright, colours: colours.size };
    });
    rep.check('the canvas holds a real picture', lit.bright > 200 && lit.colours > 5,
      `${lit.bright}/2304 lit, ${lit.colours} colours`);

    // Falling back has to work: this path is new and the old one is the one
    // that is known to survive everything.
    await page.evaluate(() => {
      for (let i = 0; i < 4; i++) {
        if (/canvas/.test(document.getElementById('transportBtn').textContent)) return;
        document.getElementById('transportBtn').click();
      }
    });
    await page.waitForTimeout(6000);
    const back = await page.evaluate(() => ({
      label: document.getElementById('transportBtn').textContent,
      mpeg: !document.getElementById('screen').classList.contains('off'),
      wc: !document.getElementById('wcscreen').classList.contains('off'),
      audio: !document.getElementById('fallbackAudio').paused,
    }));
    rep.check('switching back to canvas works', /canvas/.test(back.label) && back.mpeg && !back.wc,
      `${back.label} mpeg=${back.mpeg} wc=${back.wc}`);
    rep.check('and the soundtrack survived the switch', back.audio);
  }

  if (hasCodecs && !canDecode) {
    // The half this environment can prove: a browser that cannot decode H.264
    // must say so and go back to the path that works, without losing the sound.
    await page.evaluate(() => {
      for (let i = 0; i < 4; i++) {
        if (/H\.264/.test(document.getElementById('transportBtn').textContent)) return;
        document.getElementById('transportBtn').click();
      }
    });
    await page.waitForTimeout(9000);
    const fell = await page.evaluate(() => ({
      label: document.getElementById('transportBtn').textContent,
      toast: document.getElementById('toast').textContent,
      mpeg: !document.getElementById('screen').classList.contains('off'),
      wc: !document.getElementById('wcscreen').classList.contains('off'),
      audio: !document.getElementById('fallbackAudio').paused,
    }));
    rep.check('a browser without H.264 falls back rather than showing nothing',
      /canvas/.test(fell.label) && fell.mpeg && !fell.wc,
      `${fell.label} mpeg=${fell.mpeg} wc=${fell.wc}`);
    rep.check('and says why in plain words',
      /H\.264 çözemiyor/.test(fell.toast), fell.toast.slice(0, 70));
    rep.check('the soundtrack is not lost doing it', fell.audio);
  }

  rep.check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  fixture.close();
  rep.done('h264');
})().catch((e) => { console.error(e); process.exit(1); });
