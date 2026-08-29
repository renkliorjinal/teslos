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

/**
 * Which YouTube client to impersonate, in the order that actually matters.
 *
 * This order was guessed at for a long time and the guess was wrong in a way
 * that took days to see. yt-dlp knows, per client, whether googlevideo will
 * serve the media without a proof-of-origin token — and a client that needs one
 * still *resolves* perfectly happily. It hands back well-formed URLs and only
 * the fetch is refused, minutes later, in ffmpeg. So the chain would settle on
 * a client that could never play anything and stay there.
 *
 * Read out of the installed yt-dlp rather than remembered:
 *
 *   android_vr    no token, no auth, no JS player   <- the cheapest thing that works
 *   tv            no token, no auth
 *   web_embedded  no token, no auth
 *   tv_downgraded no token, but needs a signed-in cookie jar
 *   web, web_safari, web_music, web_creator, android, ios, mweb, tv_simply
 *                 all REQUIRE a GVS token: they resolve, and then 403
 *
 * So the three that need nothing lead, and the rest are kept only as a last
 * resort — they are still useful for metadata, which needs no token at all, and
 * YouTube's policy moves often enough that today's refusal is not permanent.
 *
 * `tv_embedded` was in this list and is not a yt-dlp client at all; it was added
 * on a hunch and would have failed every time it was reached.
 */
const CLIENT_CHAIN = (process.env.YT_DLP_CLIENTS
  || 'android_vr,tv,web_embedded,web_safari,mweb,android,ios,tv_simply,default')
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

/**
 * Clients that resolved cleanly and whose URLs the CDN then refused.
 *
 * The chain can only react to failures yt-dlp reports, and this is not one of
 * them. android_vr answers every request happily and hands back perfectly
 * well-formed URLs; the refusal happens later, in ffmpeg, as a 403. Nothing
 * carried that back, so the preferred client stayed pinned to it, every stream
 * died, and the chain never advanced to `android` sitting two places behind it
 * and working fine. From the car that is "no video plays, on any path" — for
 * days, with no code change to blame, because the change was YouTube's.
 *
 * So a refusal is reported back and the client is stood down for a while. Long
 * enough not to be retried on the next video, short enough that a client
 * YouTube stops refusing comes back on its own.
 */
const refusedUntil = new Map();
const REFUSAL_TTL_MS = 30 * 60 * 1000;

function clientRefused(client) {
  if (!client) return;
  refusedUntil.set(client, Date.now() + REFUSAL_TTL_MS);
  if (preferredClient === client) preferredClient = null;
  console.warn(`[yt-dlp] ${client} resolved but the CDN refused its URLs; `
    + `standing it down for ${REFUSAL_TTL_MS / 60000} minutes`);
}

function usableChain() {
  const now = Date.now();
  const usable = CLIENT_CHAIN.filter((c) => !(refusedUntil.get(c) > now));
  // Never leave nothing to try. Every client being refused at once says the
  // penalties are stale far more often than it says YouTube has closed the
  // door, and failing outright would be the worse guess.
  if (usable.length) return usable;
  refusedUntil.clear();
  return CLIENT_CHAIN.slice();
}

async function runWithClients(args, opts) {
  // A client that worked once is tried first next time; walking the whole
  // chain on every request would add a round trip per video.
  const chain = usableChain();
  const order = preferredClient && chain.includes(preferredClient)
    ? [preferredClient, ...chain.filter((c) => c !== preferredClient)]
    : chain;

  let lastError = new Error('yt-dlp produced no result');
  for (const client of order) {
    try {
      const out = await runYtDlp([...args, ...clientArgs(client)], opts);
      if (preferredClient !== client) {
        preferredClient = client;
        console.log(`[yt-dlp] player_client=${client} works`);
      }
      // Which client produced this matters to the caller: if the CDN refuses
      // the URLs, that is the one to stand down.
      return { out, client };
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
  const { out } = await runWithClients([
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
    // The whole header dict as JSON, because the obvious form does not work.
    //
    // `%(http_headers.User-Agent)s` returns NA, and so does every variation on
    // it — twice now I assumed otherwise and shipped a fix that silently did
    // nothing. yt-dlp's template parser accepts only word characters in a field
    // path, and `User-Agent` has a hyphen in it, so the key can never be
    // addressed that way. Asking for the dict with the `j` conversion sidesteps
    // the parser entirely and works for a merge and a single format alike.
    // Verified against yt-dlp's own evaluate_outtmpl rather than assumed.
    '--print', '%(requested_formats.0.http_headers,http_headers)j',
    '-g', watchUrl(videoId)];
}

/**
 * Which address YouTube thinks is asking, observed for free as we go.
 *
 * When a media URL carries an `ip` parameter, googlevideo has signed it for
 * that address and will serve it to nobody else. So if the proxy hands out a
 * different exit per connection, the fetch is refused however many times it is
 * retried — and no header, client or timeout will ever fix it.
 *
 * Knowing whether that is happening used to mean a special trip: two resolves
 * back to back with a browser waiting on them. But every normal resolve already
 * carries the answer, so they are simply remembered. After a few videos the
 * question is settled with no extra work at all, and /api/health can say so.
 */
const exitSeen = [];
const EXIT_MEMORY = 12;

function noteExitAddress(url) {
  try {
    const ip = new URL(url).searchParams.get('ip');
    if (!ip) return;
    exitSeen.push({ at: Date.now(), ip });
    if (exitSeen.length > EXIT_MEMORY) exitSeen.shift();
  } catch {
    // A URL that will not parse is the caller's problem, not this one's.
  }
}

// Proving the addresses differ is the point; publishing someone's proxy exits
// is not, so only enough of each survives to tell them apart.
function maskAddress(ip) {
  return ip.includes(':')
    ? `${ip.split(':').slice(0, 2).join(':')}:…`
    : `${ip.split('.').slice(0, 2).join('.')}.x.x`;
}

function exitAddresses() {
  if (!exitSeen.length) return null;
  const distinct = new Set(exitSeen.map((e) => e.ip));
  return {
    seen: exitSeen.length,
    distinct: distinct.size,
    // One address across many resolves is a sticky proxy. Several is the fault.
    rotating: distinct.size > 1,
    recent: [...distinct].slice(-4).map(maskAddress),
  };
}

function parseResolve(out) {
  const lines = out.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  const urls = lines.filter((s) => /^https?:/i.test(s));
  if (urls.length === 0) return null;

  // The header dict arrives as one JSON line among the URLs. "NA" is what
  // yt-dlp prints for a field the extractor did not set.
  let userAgent = null;
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const headers = JSON.parse(line);
      userAgent = headers['User-Agent'] || headers['user-agent'] || null;
    } catch {
      // Not the header line after all.
    }
    if (userAgent) break;
  }
  // Older shape, and the plain-string print this replaced: a bare non-URL line.
  if (!userAgent) {
    userAgent = lines.find((s) => !/^https?:/i.test(s) && !s.startsWith('{') && s !== 'NA') || null;
  }

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

  const { out, client } = await runWithClients(resolveArgs(format, videoId));
  const streams = parseResolve(out);
  if (!streams) throw new Error('yt-dlp returned no stream URL');
  // Travels with the URLs so that whoever gets refused can say who to blame.
  streams.client = client;
  noteExitAddress(streams.video);

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
  const { out } = await runWithClients([
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
  const { out } = await runWithClients([
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
  feed, feedNames, activeClient, CLIENT_CHAIN, resolveWithClient, clientRefused,
  exitAddresses,
  // For test/resolve.js. Silent misparsing here hands ffmpeg a URL with no
  // header, which is a 403 twenty seconds later and nothing in between; and a
  // chain that cannot stand a client down sits on a broken one indefinitely.
  _parseResolve: parseResolve,
  _chain: { usableChain, refusedUntil, REFUSAL_TTL_MS },
};
