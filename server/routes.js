'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const config = require('./config');
const youtube = require('./youtube');
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

// Fallback audio path: a plain MP3 body for an <audio> element, used when
// WebAudio turns out to be unavailable in Drive.
router.get('/audio', async (req, res) => {
  const videoId = youtube.parseVideoId(req.query.v);
  if (!videoId) return fail(res, 400, 'Geçersiz video kimliği');
  if (stream.atCapacity()) return fail(res, 503, 'Sunucu kapasitesi dolu');

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

router.post('/probe-report', express.json({ limit: '512kb' }), (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(config.reportsDir, { recursive: true });
  const file = path.join(config.reportsDir, `probe-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(req.body || {}, null, 2));
  console.log(`[probe] report saved: ${file}`);
  res.json({ ok: true });
});

module.exports = router;
