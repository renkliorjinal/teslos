'use strict';

/**
 * Why googlevideo said no.
 *
 * A resolve that succeeds followed by a 403 on the media fetch has three
 * plausible causes and they need opposite fixes, so guessing between them is
 * how a car ends up unable to play anything for days:
 *
 *   - the User-Agent. Several player clients get a URL that googlevideo will
 *     only serve back to the same client. ffmpeg sends "Lavf/…".
 *   - the address. A rotating residential proxy hands out a different exit IP
 *     per connection, so the fetch leaves by a different door than the resolve
 *     came in by, and an address-locked URL is refused.
 *   - the client. Some clients' URLs simply stop working, and the chain quietly
 *     falls through to one whose URLs are stricter than the last one's.
 *
 * Each is distinguishable by trying the same URL three ways and seeing which
 * combination is refused. That is all this does — it changes nothing, it just
 * reports the matrix and reads the answer out of it, from a URL that can be
 * opened on the car's own screen.
 */

const { execFile } = require('child_process');
const config = require('./config');
const youtube = require('./youtube');

// Long enough for a slow proxy to complete a TLS handshake and one range
// request, short enough that four of them in series still answer a browser.
const PROBE_TIMEOUT_MS = 25000;

/**
 * Fetch the first fraction of a second of a URL exactly as the streaming paths
 * would, and report what happened. -c copy so nothing is decoded: the question
 * is whether the bytes arrive at all.
 */
function probe(url, { userAgent, proxy }) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (userAgent) args.push('-user_agent', userAgent);
  if (proxy) args.push('-http_proxy', proxy);
  args.push('-i', url, '-t', '0.5', '-c', 'copy', '-f', 'null', '-');

  return new Promise((resolve) => {
    const started = Date.now();
    execFile(config.ffmpeg, args, { timeout: PROBE_TIMEOUT_MS }, (err, stdout, stderr) => {
      const ms = Date.now() - started;
      const tail = String(stderr || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';
      if (!err) return resolve({ ok: true, ms });
      resolve({
        ok: false,
        ms,
        // The status code is the whole answer, so it is lifted out of ffmpeg's
        // sentence rather than left for a human to find in it.
        status: (tail.match(/\b(4\d\d|5\d\d)\b/) || [])[1] || null,
        error: redactUrls(tail).slice(0, 160) || `ffmpeg exited ${err.code}`,
      });
    });
  });
}

// Signed query strings are a kilometre long and carry nothing worth reading in
// full, but *which* parameters are present is exactly what distinguishes an
// address-locked URL from one missing a proof-of-origin token. So the names
// survive and every value goes.
const TELLING = ['ip', 'ipbits', 'pot', 'expire', 'sparams', 'c', 'requiressl'];

function describeUrl(url) {
  try {
    const parsed = new URL(url);
    const names = [...parsed.searchParams.keys()];
    return {
      host: parsed.host,
      params: names.length,
      telling: TELLING.filter((k) => names.includes(k)),
    };
  } catch {
    return { host: null, params: 0, telling: [] };
  }
}

function redactUrls(text) {
  return String(text || '')
    .replace(/\/\/[^@\s/]*@/g, '//***@')
    .replace(/(https?:\/\/[^\s?]+)\?\S*/g, '$1?…');
}

/**
 * One client, resolved and then fetched three ways.
 *
 * The audio rendition is used because it is the smallest thing the CDN will
 * serve and it is refused for precisely the same reasons as the video — and
 * because on the failing car it is the audio stream that reported the 403.
 */
async function checkClient(videoId, client, proxy) {
  const row = { client, resolved: false };

  let streams;
  try {
    streams = await youtube.resolveWithClient(videoId, 480, client);
  } catch (err) {
    row.error = redactUrls(err.message).slice(0, 200);
    return row;
  }

  const url = streams.audio || streams.video;
  row.resolved = true;
  row.userAgent = streams.userAgent || null;
  Object.assign(row, describeUrl(url));

  // Three ways, and the differences between them are the diagnosis:
  //   what the server did before this change, the same with the header yt-dlp
  //   used, and the same again leaving by the droplet's own address.
  row.probes = {
    proxyNoUa: await probe(url, { proxy }),
    proxyWithUa: streams.userAgent
      ? await probe(url, { proxy, userAgent: streams.userAgent })
      : { skipped: 'yt-dlp reported no User-Agent for this client' },
    directWithUa: await probe(url, { userAgent: streams.userAgent }),
  };

  return row;
}

// Reading the matrix. Ordered by how actionable the answer is rather than by
// how likely it is, because two of these can be true at once and the cheapest
// fix should win.
function verdict(rows) {
  const usable = rows.filter((r) => r.resolved && r.probes);
  if (!usable.length) return { cause: 'resolve', says: 'Hiçbir istemci medya adresi çözemedi.' };

  const worksNow = usable.filter((r) => r.probes.proxyWithUa && r.probes.proxyWithUa.ok);
  if (worksNow.length) {
    const fixedByUa = worksNow.filter((r) => r.probes.proxyNoUa && !r.probes.proxyNoUa.ok);
    return {
      cause: fixedByUa.length ? 'user-agent' : 'none',
      client: worksNow[0].client,
      says: fixedByUa.length
        ? `Sebep User-Agent. ${fixedByUa.map((r) => r.client).join(', ')} istemcisinin adresi `
          + 'yalnızca yt-dlp\'nin kullandığı başlıkla açılıyor; ffmpeg kendi başlığını '
          + 'gönderdiği için reddediliyordu. Düzeltme zaten kurulu.'
        : `Şu an her şey çalışıyor (${worksNow[0].client}). Hata geçiciydi ya da başka yerde.`,
    };
  }

  const directOk = usable.filter((r) => r.probes.directWithUa && r.probes.directWithUa.ok);
  if (directOk.length) {
    return {
      cause: 'proxy',
      client: directOk[0].client,
      says: 'Sebep proxy. Aynı adres sunucunun kendi bağlantısından açılıyor, proxy üzerinden '
        + 'açılmıyor — büyük ihtimalle her bağlantıda farklı çıkış IP\'si veren dönen bir proxy, '
        + 'YouTube ise adresi çözen IP\'ye bağlıyor. Sabit (sticky) oturum gerekiyor, '
        + 'ya da medya proxy\'siz çekilmeli: PROXY_MEDIA=0',
    };
  }

  return {
    cause: 'unknown',
    says: 'Üç yol da reddedildi. Aşağıdaki durum kodlarına bakmak gerekiyor — '
      + 'çözülen adres muhtemelen bir proof-of-origin (pot) belirteci istiyor, '
      + 'bu da çerez kavanozu gerektirir.',
  };
}

/**
 * The whole check. Defaults to the client currently in use plus the two ahead
 * of it in the chain, because "which client should we be on" is half the
 * question; ?all=1 walks the lot at roughly four seconds a client.
 */
async function run(videoId, { all = false } = {}) {
  const chain = youtube.CLIENT_CHAIN;
  const active = youtube.activeClient();
  const clients = all
    ? chain
    : [...new Set([active, ...chain.slice(0, 3)])].filter(Boolean);

  const proxy = config.proxyMedia && config.proxyUsableByFfmpeg ? config.proxy : null;

  const rows = [];
  for (const client of clients) {
    rows.push(await checkClient(videoId, client, proxy));
  }

  return {
    videoId,
    activeClient: active,
    proxy: config.maskProxy(config.proxy) || null,
    proxyUsedForMedia: Boolean(proxy),
    cookies: Boolean(config.cookies),
    verdict: verdict(rows),
    clients: rows,
  };
}

module.exports = { run, verdict, describeUrl };
