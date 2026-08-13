'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const config = require('./config');
const youtube = require('./youtube');
const oauth = require('./oauth');
const stream = require('./stream');

const router = express.Router();

function fail(res, status, message) {
  res.status(status).json({ ok: false, error: message });
}

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    sessions: stream.sessionCount(),
    maxSessions: config.maxSessions,
    defaultQuality: config.DEFAULT_QUALITY,
    qualities: Object.keys(config.QUALITY).map(Number),
    // The client needs these to turn bytes received into seconds buffered,
    // which is what it reports back for flow control.
    bitrates: Object.fromEntries(Object.entries(config.QUALITY)
      .map(([height, preset]) => [height, parseInt(preset.videoBitrate, 10) * 1000])),
    ytClient: youtube.activeClient(),
    cookies: Boolean(config.cookies),
    google: oauth.signedIn(),
    // Which tabs the picker should offer. The cookie jar can serve everything;
    // a Google sign-in serves a subset; with neither, only Popüler works. The
    // two overlap but are not nested — playlists come only from Google — so
    // this is a union rather than a choice.
    feeds: [...new Set([
      ...(config.cookies ? youtube.feedNames() : []),
      ...oauth.status().feeds,
      'trending',
    ])],
    proxy: config.maskProxy(config.proxy) || null,
    proxyMedia: config.proxyMedia && config.proxyUsableByFfmpeg,
  });
});

router.get('/meta', async (req, res) => {
  const videoId = youtube.parseVideoId(req.query.v);
  if (!videoId) return fail(res, 400, 'Geçersiz YouTube bağlantısı veya video kimliği');

  try {
    const meta = await youtube.getMetadata(videoId);
    res.json({ ok: true, ...meta });
  } catch (err) {
    fail(res, 502, err.message);
  }
});

router.get('/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return fail(res, 400, 'Arama terimi boş');

  try {
    const results = await youtube.search(query, req.query.limit);
    res.json({ ok: true, results });
  } catch (err) {
    fail(res, 502, err.message);
  }
});

// Two possible sources. The cookie jar is the richer one — it is the only
// thing that can reach watch history or the home page — so it wins when it is
// there. A Google sign-in covers subscriptions, likes and playlists, and is the
// only one obtainable without a desktop browser.
//
// A jar that has lapsed fails in a way that looks exactly like a jar that was
// never uploaded, so when the preferred source refuses, try the other before
// telling the driver there is nothing to show.
router.get('/feed', async (req, res) => {
  const name = String(req.query.name || 'recommended');

  const sources = [];
  if (config.cookies) sources.push(() => youtube.feed(name, req.query.limit));
  if (oauth.canServe(name)) sources.push(() => oauth.feed(name, req.query.limit));
  // With neither credential only `trending` has anything in it, and youtube.js
  // is the one that knows how to say so.
  if (!sources.length) sources.push(() => youtube.feed(name, req.query.limit));

  let lastError;
  for (const load of sources) {
    try {
      const items = await load();
      res.json({ ok: true, name, items });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  fail(res, 502, lastError.message);
});

// ------------------------------------------------------------------- google
//
// Signing in to YouTube from a phone. The cookie jar needs a browser extension
// on a real computer; this needs a Google Cloud project, which is tedious to
// create but can be done entirely on a touchscreen. It buys subscriptions,
// likes and playlists — not watch history, which Google exposes to no API.

router.get('/auth/status', (req, res) => {
  res.json({ ok: true, ...oauth.status() });
});

router.post('/auth/config', express.json({ limit: '8kb' }), (req, res) => {
  if (!requireToken(req, res)) return;
  try {
    oauth.setCredentials(req.body && req.body.clientId, req.body && req.body.clientSecret);
  } catch (err) {
    return fail(res, 400, err.message);
  }
  console.log('[oauth] client credentials stored');
  res.json({ ok: true, ...oauth.status() });
});

// A redirect rather than JSON, so the setup page is a plain link and the car's
// browser follows it the way it would any other.
router.get('/auth/start', (req, res) => {
  if (!requireTokenValue(String(req.query.k || ''), res)) return;
  if (!oauth.configured()) return fail(res, 400, 'Google istemci bilgileri girilmemiş');
  const target = oauth.authUrl();
  if (!target) return fail(res, 400, 'TESLOS_DOMAIN tanımlı değil; yönlendirme adresi kurulamıyor');
  res.redirect(target);
});

// Google sends the browser back here. Whatever happens the answer is a page,
// not JSON — a person is looking at it.
router.get('/auth/callback', async (req, res) => {
  const done = (title, detail, ok) => {
    res.status(ok ? 200 : 400).type('html').send(`<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>teslos · giriş</title><link rel="stylesheet" href="/shared/style.css"></head>
<body><div class="wrap"><div class="panel">
<h1 style="margin:0 0 10px">${ok ? '✓' : '✕'} ${title}</h1>
<p class="muted" style="line-height:1.6">${detail}</p>
<p style="margin-top:18px"><a class="btn primary" href="/" style="text-decoration:none">OYNATICIYA DÖN</a>
&nbsp;<a class="btn" href="/setup/" style="text-decoration:none">KURULUM</a></p>
</div></div></body></html>`);
  };

  if (req.query.error) {
    return done('Giriş iptal edildi', String(req.query.error).slice(0, 200), false);
  }
  if (!oauth.stateOk(String(req.query.state || ''))) {
    return done('Giriş doğrulanamadı',
      'Bağlantı eskimiş olabilir. /setup/ sayfasından yeniden başlat.', false);
  }

  try {
    await oauth.exchangeCode(String(req.query.code || ''));
  } catch (err) {
    return done('Giriş tamamlanamadı', err.message, false);
  }
  console.log('[oauth] signed in');
  done('YouTube hesabın bağlandı',
    'Abonelikler, beğendiklerin ve oynatma listelerin artık oynatıcıda. '
    + 'İzleme geçmişi ve ana sayfa önerileri Google tarafından hiçbir API\'ye açılmıyor.', true);
});

router.post('/auth/logout', (req, res) => {
  if (!requireToken(req, res)) return;
  oauth.forget();
  console.log('[oauth] signed out');
  res.json({ ok: true, ...oauth.status() });
});

// Direct path: a remuxed MP4 body for an ordinary <video> element. No
// transcoding, so this costs a fraction of the canvas path and looks far
// better. Seeking works by re-requesting with a new ?t= — a piped fragmented
// MP4 carries no index for the browser to seek within.
router.get('/stream', async (req, res) => {
  const videoId = youtube.parseVideoId(req.query.v);
  if (!videoId) return fail(res, 400, 'Geçersiz video kimliği');
  if (stream.atCapacity()) return fail(res, 503, 'Sunucu kapasitesi dolu');

  const quality = config.resolveQuality(req.query.q);
  const startTime = Math.max(0, Number(req.query.t) || 0);

  // Chrome asks for a byte range on every media request. This body is a live
  // pipe with no index and no length, so a range cannot be honoured — and
  // answering one by starting a fresh ffmpeg would hand the browser
  // start-of-file bytes where it expected an offset, which it experiences as a
  // frozen picture rather than an error. Saying "none" up front stops it asking.
  if (req.headers.range) {
    console.log(`[direct] ${videoId}: browser asked for range ${req.headers.range}; serving whole stream`);
  }

  let session;
  try {
    session = await stream.startDirectStream({ videoId, quality, startTime });
  } catch (err) {
    return fail(res, 502, err.message);
  }

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'none',
    'Cache-Control': 'no-store',
    'Connection': 'close',
  });

  session.stdout.pipe(res);
  session.proc.on('close', () => res.end());
  res.on('close', () => session.stop());
});

// Fallback audio path: a plain MP3 body for an <audio> element, used when
// WebAudio turns out to be unavailable in Drive.
router.get('/audio', async (req, res) => {
  const videoId = youtube.parseVideoId(req.query.v);
  if (!videoId) return fail(res, 400, 'Geçersiz video kimliği');
  if (stream.audioAtCapacity()) return fail(res, 503, 'Ses akışı kapasitesi dolu');

  const startTime = Math.max(0, Number(req.query.t) || 0);

  let session;
  try {
    session = await stream.startAudioStream({ videoId, startTime });
  } catch (err) {
    return fail(res, 502, err.message);
  }

  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-store',
    'Connection': 'close',
  });

  session.stdout.pipe(res);
  session.proc.on('close', () => res.end());
  res.on('close', () => session.stop());
});

// Probe fixtures. Both are synthesised by ffmpeg rather than committed as
// binaries, so the probe can answer "does Tesla pause <video> / does <audio>
// still play" without the repo carrying media files.
router.get('/testclip.mp4', (req, res) => {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    // faststart is impossible on a pipe, so fragment instead — the browser can
    // begin playing a fragmented MP4 as it arrives.
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', '-',
  ];
  pipeFfmpeg(res, args, 'video/mp4');
});

// A short clip of raw encoded frames for the probe's WebCodecs test. H.264
// arrives as Annex-B with access unit delimiters, so frame boundaries are
// trivial to find; VP8 arrives as IVF, whose per-frame headers carry sizes.
// Two codecs because a browser may well have WebCodecs without H.264.
router.get('/testcodec', (req, res) => {
  const source = ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=3'];
  const args = ['-hide_banner', '-loglevel', 'error', ...source];

  if (req.query.c === 'vp8') {
    args.push(
      '-c:v', 'libvpx', '-b:v', '400k', '-deadline', 'realtime', '-cpu-used', '8',
      '-g', '15', '-pix_fmt', 'yuv420p', '-f', 'ivf', '-',
    );
  } else {
    args.push(
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-profile:v', 'baseline', '-level', '3.0', '-bf', '0', '-g', '15',
      '-pix_fmt', 'yuv420p',
      // Access unit delimiters turn frame splitting into a start-code scan.
      '-bsf:v', 'h264_metadata=aud=insert',
      '-f', 'h264', '-',
    );
  }

  pipeFfmpeg(res, args, 'application/octet-stream');
});

router.get('/testtone.mp3', (req, res) => {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
    '-c:a', 'libmp3lame', '-b:a', '96k', '-ar', '44100', '-ac', '2',
    '-f', 'mp3', '-',
  ];
  pipeFfmpeg(res, args, 'audio/mpeg');
});

function pipeFfmpeg(res, args, contentType) {
  const proc = spawn(config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  proc.stdout.pipe(res);
  proc.stderr.resume();
  proc.on('close', () => res.end());
  proc.on('error', () => res.end());
  res.on('close', () => {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  });
}

// ---------------------------------------------------------------- cookies
//
// Signing in to YouTube means putting a cookie jar on the server, and the only
// way to produce one is a browser extension on a real computer. Getting the
// file across then needs SSH, which is a poor thing to require from a car. This
// accepts a paste instead.
//
// It writes a live credential to disk on a public host, so it is off unless
// SETUP_TOKEN is set, and it never reads anything back out.

function requireTokenValue(given, res) {
  if (!config.setupToken) {
    fail(res, 503, 'SETUP_TOKEN tanımlı değil; kurulum sayfası kapalı');
    return false;
  }
  if (given.length !== config.setupToken.length || given !== config.setupToken) {
    fail(res, 401, 'Kurulum anahtarı hatalı');
    return false;
  }
  return true;
}

// The header is the normal carrier. /auth/start is the exception: it is a link
// the browser follows, so its token travels in the query string.
function requireToken(req, res) {
  return requireTokenValue(req.get('x-setup-token') || '', res);
}

// Reports on the jar without disclosing it: how many cookies, for which
// domains, and when the earliest one lapses.
function describeCookies() {
  if (!fs.existsSync(config.cookiesPath)) return { present: false };

  const lines = fs.readFileSync(config.cookiesPath, 'utf8').split('\n');
  const domains = new Set();
  let count = 0;
  let soonest = Infinity;

  for (const line of lines) {
    if (!line.trim() || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    count += 1;
    domains.add(parts[0].replace(/^#HttpOnly_/, ''));
    const expiry = Number(parts[4]);
    // Zero means a session cookie, which never lapses on a clock.
    if (expiry > 0 && expiry < soonest) soonest = expiry;
  }

  return {
    present: true,
    count,
    domains: [...domains].slice(0, 8),
    expiresAt: isFinite(soonest) ? new Date(soonest * 1000).toISOString() : null,
    path: config.cookiesPath,
  };
}

router.get('/cookies', (req, res) => {
  if (!requireToken(req, res)) return;
  res.json({ ok: true, ...describeCookies() });
});

router.post('/cookies', express.text({ limit: '512kb', type: '*/*' }), (req, res) => {
  if (!requireToken(req, res)) return;

  const body = String(req.body || '').replace(/\r\n/g, '\n').trim();
  if (!body) return fail(res, 400, 'Boş içerik');

  const rows = body.split('\n').filter((line) => {
    if (!line.trim()) return false;
    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) return false;
    return line.split('\t').length >= 7;
  });

  if (!rows.length) {
    return fail(res, 400,
      'Netscape biçiminde satır bulunamadı. Alanlar TAB ile ayrılmalı — '
      + 'kopyalarken sekmeler boşluğa dönmüş olabilir.');
  }
  if (!rows.some((line) => /youtube\.com|google\.com/i.test(line.split('\t')[0]))) {
    return fail(res, 400, 'Dosyada youtube.com çerezi yok; yanlış site dışa aktarılmış olabilir.');
  }

  // yt-dlp insists on the header line; exporters do not always include it.
  const header = '# Netscape HTTP Cookie File';
  const content = (body.startsWith('#') ? body : header + '\n' + body) + '\n';

  try {
    fs.writeFileSync(config.cookiesPath, content, { mode: 0o600 });
    fs.chmodSync(config.cookiesPath, 0o600);
  } catch (err) {
    return fail(res, 500, 'Yazılamadı: ' + config.explainWriteFailure(err));
  }

  console.log(`[cookies] jar saved with ${rows.length} cookies`);
  res.json({ ok: true, ...describeCookies() });
});

router.delete('/cookies', (req, res) => {
  if (!requireToken(req, res)) return;
  try {
    if (fs.existsSync(config.cookiesPath)) fs.unlinkSync(config.cookiesPath);
  } catch (err) {
    return fail(res, 500, err.message);
  }
  console.log('[cookies] jar removed');
  res.json({ ok: true, present: false });
});

router.post('/probe-report', express.json({ limit: '512kb' }), (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(config.reportsDir, { recursive: true });
  const file = path.join(config.reportsDir, `probe-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(req.body || {}, null, 2));
  console.log(`[probe] report saved: ${file}`);
  res.json({ ok: true });
});

module.exports = router;
