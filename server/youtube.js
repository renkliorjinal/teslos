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

// noProxy is for the media check alone, which has to be able to ask what the
// droplet's own address gets — the difference between the two answers is the
// diagnosis.
function baseArgs({ noProxy = false } = {}) {
  const args = ['--no-warnings', '--no-playlist'];
  if (config.cookies) args.push('--cookies', config.cookies);
  // A residential or mobile exit sidesteps the bot check that a datacenter
  // address walks straight into.
  if (config.proxy && !noProxy) args.push('--proxy', config.proxy);
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

// YouTube answers a datacenter IP with "Sign in to confirm you're not a bot",
// which is fatal to every request this server makes. Impersonating a different
// YouTube client often gets through where the default does not, and costs
// nothing to try.
//
// The order puts first the clients that need neither authentication nor the JS
// player, so they sidestep the proof-of-origin dance entirely.
// The tail of the chain is reached only when everything ahead of it has already
// failed, so extra candidates there cost nothing and have rescued this once
// already: YouTube's SABR rollout leaves several clients returning formats with
// no URL at all, and which ones those are changes without warning.
const CLIENT_CHAIN = (process.env.YT_DLP_CLIENTS
  || 'tv_simply,android_vr,ios,android,tv,mweb,web_safari,tv_embedded,web_embedded,default')
  .split(',').map((s) => s.trim()).filter(Boolean);

let preferredClient = null;

function clientArgs(client) {
  return client && client !== 'default'
    ? ['--extractor-args', `youtube:player_client=${client}`]
    : [];
}

// A video that is private or deleted will fail identically on every client, so
// only retry the failures that are about being refused rather than absent.
function worthRetrying(message) {
  if (/private video|video unavailable|removed by the uploader|does not exist|members[- ]only/i.test(message)) {
    return false;
  }
  return /not a bot|sign in|po[_ ]?token|nsig|failed to extract|no video formats|requested format|unable to (download|extract)/i
    .test(message);
}

async function runWithClients(args, opts) {
  // A client that worked once is tried first next time; walking the whole
  // chain on every request would add a round trip per video.
  const order = preferredClient
    ? [preferredClient, ...CLIENT_CHAIN.filter((c) => c !== preferredClient)]
    : CLIENT_CHAIN.slice();

  let lastError = new Error('yt-dlp produced no result');
  for (const client of order) {
    try {
      const out = await runYtDlp([...args, ...clientArgs(client)], opts);
      if (preferredClient !== client) {
        preferredClient = client;
        console.log(`[yt-dlp] player_client=${client} works`);
      }
      return out;
    } catch (err) {
      lastError = err;
      if (!worthRetrying(err.message)) throw err;
      if (preferredClient === client) preferredClient = null;
    }
  }

  if (/not a bot|sign in|po[_ ]?token/i.test(lastError.message)) {
    throw new Error('YouTube bu sunucuyu bot sanıyor; hiçbir istemci geçemedi. YT_DLP_COOKIES gerekiyor.');
  }
  throw lastError;
}

function activeClient() {
  return preferredClient;
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
  const out = await runWithClients([
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

// YouTube's media URLs stay valid for hours, so resolving the same video twice
// within seconds is pure latency and one more chance to fail. The audio
// companion stream in particular asks for exactly what the video stream just
// looked up.
const resolveCache = new Map();
const RESOLVE_TTL_MS = 5 * 60 * 1000;

function cacheKey(videoId, height, requireAvc) {
  return `${videoId}|${height}|${requireAvc ? 'avc' : 'any'}`;
}

// Resolves direct media URLs. YouTube serves DASH, so the best video and best
// audio usually come back as two separate URLs; progressive formats come back
// as one. Both shapes are normalised into { video, audio }.
//
// av01 is excluded because software AV1 decode on a small droplet cannot keep
// up with realtime transcoding.
/**
 * The resolve command, and why it asks for a header as well as a URL.
 *
 * ffmpeg fetches these URLs, not yt-dlp — and for several of the player clients
 * googlevideo will only serve one to the User-Agent that asked for it. ffmpeg
 * sends its own "Lavf/…", so the resolve succeeds, the fetch is refused with a
 * bare 403, and from the car it looks like the video is broken rather than the
 * request. The header therefore comes back alongside the URLs and travels with
 * them to ffmpeg.
 *
 * --print runs before -g, so the User-Agent is the first line; the parser does
 * not rely on that, since the two options are documented as an ordered list and
 * one yt-dlp release reordering them would be a silent 403 again.
 */
function resolveArgs(format, videoId, opts) {
  return [...baseArgs(opts), '-f', format,
    // Where the header actually lives, in the order it should be preferred.
    // Asking only for the top-level one returned "NA" on the very case this
    // exists for: selecting bestvideo+bestaudio produces a merge, and a merge
    // keeps its headers per-format under requested_formats rather than hoisting
    // them. The check duly skipped the probe that mattered and reported nothing.
    // Comma-separated alternatives are yt-dlp's own "first one that exists".
    '--print', '%(requested_formats.0.http_headers.User-Agent,http_headers.User-Agent,formats.0.http_headers.User-Agent)s',
    '-g', watchUrl(videoId)];
}

function parseResolve(out) {
  const lines = out.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  const urls = lines.filter((s) => /^https?:/i.test(s));
  if (urls.length === 0) return null;
  // Anything that is not a URL is the header line. "NA" is what yt-dlp prints
  // for a field the extractor did not set, and is not a User-Agent.
  const userAgent = lines.find((s) => !/^https?:/i.test(s) && s !== 'NA') || null;
  return urls.length === 1
    ? { video: urls[0], audio: null, userAgent }
    : { video: urls[0], audio: urls[1], userAgent };
}

// One client, no cache, no chain — for the media check, which needs to compare
// clients against each other rather than take the first that answers.
async function resolveWithClient(videoId, height, client, { noProxy = false } = {}) {
  const format = `bestvideo[height<=${height}][vcodec!*=av01]+bestaudio/best[height<=${height}]/best`;
  const out = await runYtDlp(
    [...resolveArgs(format, videoId, { noProxy }), ...clientArgs(client)],
    { timeout: 45000 });
  const streams = parseResolve(out);
  if (!streams) throw new Error('no stream URL');
  return streams;
}

async function resolveStreams(videoId, height, { requireAvc = false } = {}) {
  const key = cacheKey(videoId, height, requireAvc);
  const hit = resolveCache.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.streams;
  // Remuxing into MP4 without re-encoding only works if the tracks already are
  // H.264 and AAC. requireAvc therefore admits nothing else and fails loudly
  // when there is no such rendition — falling back to VP9 here would produce an
  // MP4 the car plays as sound over a frozen picture, which looks like a bug
  // anywhere but the place that caused it.
  const format = requireAvc
    ? [
      `bestvideo[height<=${height}][vcodec^=avc1]+bestaudio[acodec^=mp4a]`,
      `best[height<=${height}][vcodec^=avc1][acodec^=mp4a]`,
    ].join('/')
    : [
      `bestvideo[height<=${height}][vcodec!*=av01]+bestaudio`,
      `best[height<=${height}]`,
      'best',
    ].join('/');

  const out = await runWithClients(resolveArgs(format, videoId));
  const streams = parseResolve(out);
  if (!streams) throw new Error('yt-dlp returned no stream URL');

  resolveCache.set(key, { at: Date.now(), streams });
  // The map is per-video and short-lived, but a long session should not let it
  // grow without bound.
  if (resolveCache.size > 64) {
    for (const [k, v] of resolveCache) {
      if (Date.now() - v.at > RESOLVE_TTL_MS) resolveCache.delete(k);
    }
  }
  return streams;
}

// A URL that failed has to be thrown away, or the cache hands the same broken
// one to every retry for the next five minutes. YouTube's media URLs can stop
// working before they expire — a CDN node drops them, or the address they were
// bound to is refused — and a reconnect that keeps replaying the same dead URL
// looks from the driver's seat like the video itself being broken. Another
// video plays, and the first one starts working again "by itself" once the
// entry ages out, which is a miserable thing to debug.
function forgetResolve(videoId) {
  for (const key of resolveCache.keys()) {
    if (key.startsWith(`${videoId}|`)) resolveCache.delete(key);
  }
}

// The feeds a signed-in account exposes. Everything but `trending` needs the
// cookie jar; without it YouTube serves a signed-out page and yt-dlp finds
// nothing, which is worth telling the user rather than showing an empty grid.
const FEEDS = {
  recommended: { url: 'https://www.youtube.com/feed/recommended', needsAuth: true },
  subscriptions: { url: 'https://www.youtube.com/feed/subscriptions', needsAuth: true },
  history: { url: 'https://www.youtube.com/feed/history', needsAuth: true },
  watch_later: { url: 'https://www.youtube.com/feed/watch_later', needsAuth: true },
  liked: { url: 'https://www.youtube.com/playlist?list=LL', needsAuth: true },
  trending: { url: 'https://www.youtube.com/feed/trending', needsAuth: false },
};

function feedNames() {
  return Object.keys(FEEDS);
}

async function feed(name, limit = 24) {
  const entry = FEEDS[name];
  if (!entry) throw new Error(`Bilinmeyen liste: ${name}`);
  if (entry.needsAuth && !config.cookies) {
    throw new Error('Bu liste için YouTube girişi gerekiyor');
  }

  const count = Math.min(Math.max(Number(limit) || 24, 1), 50);
  const out = await runWithClients([
    ...baseArgs(),
    '--flat-playlist',
    '--playlist-end', String(count),
    '--print', printJson(['id', 'title', 'duration', 'uploader', 'channel']),
    entry.url,
  ], { timeout: 60000 });

  return parseJsonLines(out)
    .map((info) => ({
      videoId: text(info.id),
      title: text(info.title, text(info.id)),
      duration: seconds(info.duration),
      uploader: text(info.uploader) || text(info.channel),
    }))
    .filter((item) => VIDEO_ID.test(item.videoId));
}

async function search(query, limit = 12) {
  const count = Math.min(Math.max(Number(limit) || 12, 1), 25);
  const out = await runWithClients([
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

module.exports = {
  parseVideoId, watchUrl, getMetadata, resolveStreams, forgetResolve, search,
  feed, feedNames, activeClient, CLIENT_CHAIN, resolveWithClient,
  // For test/resolve.js. Silent misparsing here hands ffmpeg a URL with no
  // header, which is a 403 twenty seconds later and nothing in between.
  _parseResolve: parseResolve,
};
