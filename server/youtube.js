'use strict';

const { execFile } = require('child_process');
const config = require('./config');

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// Accepts a bare 11-character id or any of the usual YouTube URL shapes and
// returns the canonical id. Anything unrecognised returns null so callers can
// reject it before it ever reaches a child process.
function parseVideoId(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (VIDEO_ID.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return VIDEO_ID.test(id) ? id : null;
  }
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'music.youtube.com') {
    return null;
  }

  const v = url.searchParams.get('v');
  if (v && VIDEO_ID.test(v)) return v;

  // /shorts/<id>, /embed/<id>, /live/<id>, /v/<id>
  const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function baseArgs() {
  const args = ['--no-warnings', '--no-playlist'];
  if (config.cookies) args.push('--cookies', config.cookies);
  return args;
}

function runYtDlp(args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(config.ytDlp, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || '').trim().split('\n').slice(-3).join(' ');
        reject(new Error(detail || 'yt-dlp failed'));
        return;
      }
      resolve(stdout.toString());
    });
  });
}

// `%(.{a,b})j` asks yt-dlp for a JSON object holding just those fields, which
// avoids inventing a delimiter that a video title could contain anyway.
function printJson(fields) {
  return `%(.{${fields.join(',')}})j`;
}

function parseJsonLines(out) {
  const rows = [];
  for (const line of out.trim().split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // A partial line is not worth failing the whole request over.
    }
  }
  return rows;
}

function text(value, fallback = '') {
  return typeof value === 'string' && value && value !== 'NA' ? value : fallback;
}

function seconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Title, duration and thumbnail for the player chrome. Deliberately a --print
// call rather than -J: the full JSON dump for a long video is several MB.
async function getMetadata(videoId) {
  const out = await runYtDlp([
    ...baseArgs(),
    '--print', printJson(['id', 'title', 'duration', 'is_live', 'uploader', 'thumbnail']),
    watchUrl(videoId),
  ]);

  const info = parseJsonLines(out)[0];
  if (!info) throw new Error('yt-dlp returned no metadata');

  return {
    videoId,
    title: text(info.title, videoId),
    // Live streams report null duration, which the client reads as "no seek bar".
    duration: seconds(info.duration),
    isLive: info.is_live === true,
    uploader: text(info.uploader),
    thumbnail: text(info.thumbnail),
  };
}

// Resolves direct media URLs. YouTube serves DASH, so the best video and best
// audio usually come back as two separate URLs; progressive formats come back
// as one. Both shapes are normalised into { video, audio }.
//
// av01 is excluded because software AV1 decode on a small droplet cannot keep
// up with realtime transcoding.
async function resolveStreams(videoId, height) {
  const format = [
    `bestvideo[height<=${height}][vcodec!*=av01]+bestaudio`,
    `best[height<=${height}]`,
    'best',
  ].join('/');

  const out = await runYtDlp([...baseArgs(), '-f', format, '-g', watchUrl(videoId)]);
  const urls = out.trim().split('\n').map((s) => s.trim()).filter((s) => s.startsWith('http'));

  if (urls.length === 0) throw new Error('yt-dlp returned no stream URL');
  if (urls.length === 1) return { video: urls[0], audio: null };
  return { video: urls[0], audio: urls[1] };
}

async function search(query, limit = 12) {
  const count = Math.min(Math.max(Number(limit) || 12, 1), 25);
  const out = await runYtDlp([
    ...baseArgs(),
    '--flat-playlist',
    '--print', printJson(['id', 'title', 'duration', 'uploader']),
    `ytsearch${count}:${query}`,
  ], { timeout: 45000 });

  return parseJsonLines(out)
    .map((info) => ({
      videoId: text(info.id),
      title: text(info.title, text(info.id)),
      duration: seconds(info.duration),
      uploader: text(info.uploader),
    }))
    .filter((item) => VIDEO_ID.test(item.videoId));
}

module.exports = { parseVideoId, watchUrl, getMetadata, resolveStreams, search };
