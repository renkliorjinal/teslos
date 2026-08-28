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
// request, short enough that a dozen of them in series still answer inside
// nginx's sixty-second patience. A refusal comes back in well under a second;
// this ceiling only bites on a proxy that has stopped answering, which is
// itself the finding.
const PROBE_TIMEOUT_MS = 12000;

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
        // sentence rather than left for a human to find in it — but only from
        // the phrase that reports one. A bare three-digit match reads the signed
        // query string instead and confidently reported "526" for a plain 403,
        // which is worse than saying nothing at all.
        status: (tail.match(/(?:returned|error)\s+(\d{3})\b/i) || [])[1] || null,
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

  // Four ways, and the differences between them are the diagnosis:
  //   what the server did before the header was added, the same with it, the
  //   same again leaving by the droplet's own address, and the whole thing done
  //   without the proxy at either end.
  row.probes = {
    proxyNoUa: await probe(url, { proxy }),
    proxyWithUa: streams.userAgent
      ? await probe(url, { proxy, userAgent: streams.userAgent })
      : { skipped: 'yt-dlp reported no User-Agent for this client' },
    directWithUa: await probe(url, { userAgent: streams.userAgent }),
  };

  // The one combination the first three cannot express. If the URL is locked to
  // whichever address resolved it, then fetching a proxy-resolved URL from the
  // droplet fails for the same reason fetching it through a *rotating* proxy
  // does — both are the wrong address — and the two are indistinguishable until
  // one address is used consistently for both halves.
  if (proxy && !row.probes.proxyWithUa.ok && !row.probes.directWithUa.ok) {
    try {
      const own = await youtube.resolveWithClient(videoId, 480, client, { noProxy: true });
      row.probes.noProxyAtAll = await probe(own.audio || own.video,
        { userAgent: own.userAgent });
    } catch (err) {
      row.probes.noProxyAtAll = {
        ok: false,
        error: `proxysiz çözülemedi: ${redactUrls(err.message).slice(0, 120)}`,
      };
    }
  }

  return row;
}

/**
 * Whether the proxy hands out a different address per connection.
 *
 * Decisive and nearly free: googlevideo writes the requesting address into the
 * URL it signs, as `ip=`. Resolve twice and compare. Two different answers mean
 * every ffmpeg connection leaves by a door YouTube has not signed for, which no
 * amount of header-setting will fix — it needs a sticky session.
 *
 * The addresses themselves are reported with the host part masked: proving they
 * differ is the point, publishing someone's proxy exits is not.
 */
async function checkRotation(videoId, client) {
  const seen = [];
  for (let i = 0; i < 2; i++) {
    try {
      const streams = await youtube.resolveWithClient(videoId, 480, client);
      const url = new URL(streams.audio || streams.video);
      seen.push(url.searchParams.get('ip'));
    } catch {
      return { checked: false, why: 'çözümleme başarısız' };
    }
  }
  if (!seen[0] || !seen[1]) return { checked: false, why: 'adreste ip= parametresi yok' };
  const mask = (ip) => ip.split(':').length > 2
    ? `${ip.split(':').slice(0, 2).join(':')}:…`
    : ip.split('.').slice(0, 2).concat(['x', 'x']).join('.');
  return {
    checked: true,
    same: seen[0] === seen[1],
    addresses: seen.map(mask),
  };
}

// Reading the matrix. Ordered by how actionable the answer is rather than by
// how likely it is, because two of these can be true at once and the cheapest
// fix should win.
// yt-dlp reports no header for some clients, and then the header probe is
// skipped rather than run — in which case the plain one already is the best
// this client can manage and is what the verdict must read.
function bestProxyProbe(row) {
  const withUa = row.probes && row.probes.proxyWithUa;
  if (withUa && !withUa.skipped) return withUa;
  return (row.probes && row.probes.proxyNoUa) || null;
}

// A client that returns formats carrying no URL at all. YouTube's SABR rollout
// does this, and it is nothing like a video being unavailable — the video is
// fine, that client just cannot be downloaded from any more.
const SABR = /format is not available|no video formats|missing a url|sabr/i;

function verdict(rows, rotation) {
  const usable = rows.filter((r) => r.resolved && r.probes);
  const sabr = rows.filter((r) => !r.resolved && SABR.test(r.error || ''));

  if (!usable.length) {
    if (sabr.length) {
      return {
        cause: 'sabr',
        says: `${sabr.map((r) => r.client).join(', ')} istemcilerinin hiçbiri indirilebilir `
          + 'bir adres vermiyor — YouTube bunlara artık yalnızca SABR akışı sunuyor, '
          + 'yani video sağlam ama bu istemcilerden çekilemiyor. Çerez kavanozu '
          + '(YT_DLP_COOKIES) gerekiyor; girişli bir hesapla web_safari yeniden adres verir.',
      };
    }
    const why = rows.map((r) => r.error).filter(Boolean)[0] || '';
    return {
      cause: 'resolve',
      says: 'Hiçbir istemci medya adresi çözemedi — bu bir oynatma sorunu değil, '
        + 'video hiç çözülemiyor. Video kimliği doğru mu? '
        + (why ? `yt-dlp: ${why}` : ''),
    };
  }

  const worksNow = usable.filter((r) => { const p = bestProxyProbe(r); return p && p.ok; });
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

  // A rotating proxy is checked before the address comparison, because it makes
  // every address wrong and no combination of the others can succeed.
  if (rotation && rotation.checked && rotation.same === false) {
    return {
      cause: 'proxy-rotating',
      says: 'Sebep proxy. Art arda iki çözümleme iki farklı çıkış adresi verdi '
        + `(${rotation.addresses.join(' ve ')}), yani proxy her bağlantıda IP değiştiriyor. `
        + 'YouTube adresi çözen IP\'ye bağladığı için ffmpeg her seferinde yanlış kapıdan '
        + 'çekiyor. Çözüm: proxy sağlayıcısında sabit (sticky) oturum aç — genelde kullanıcı '
        + 'adına -session-xxxx eki gerekir — ya da proxy\'yi tamamen kaldır.',
    };
  }

  const directOk = usable.filter((r) => r.probes.directWithUa && r.probes.directWithUa.ok);
  if (directOk.length) {
    return {
      cause: 'proxy-media',
      client: directOk[0].client,
      says: 'Sebep proxy. Aynı adres sunucunun kendi bağlantısından açılıyor, proxy üzerinden '
        + 'açılmıyor. Medyanın proxy\'siz çekilmesi yeterli: PROXY_MEDIA=0',
    };
  }

  const fullyDirectOk = usable.filter((r) => r.probes.noProxyAtAll && r.probes.noProxyAtAll.ok);
  if (fullyDirectOk.length) {
    return {
      cause: 'proxy-entirely',
      client: fullyDirectOk[0].client,
      says: 'Sebep proxy. Proxy hiç kullanılmadığında — hem çözümleme hem çekme sunucunun '
        + 'kendi adresinden — her şey çalışıyor. YouTube adresi çözen IP\'ye bağlıyor ve '
        + 'proxy ile sunucu iki farklı adres. Proxy\'yi kaldır: PROXY_URL boş bırakılmalı. '
        + '(Bot kontrolü geri gelirse çerez kavanozu gerekir.)',
    };
  }

  // Every path refused. The URL's own parameters say a great deal about why,
  // and now that they survive redaction they can be read rather than guessed at.
  const addressLocked = usable.some((r) => (r.telling || []).includes('ip'));
  const hasToken = usable.some((r) => (r.telling || []).includes('pot'));
  const others = sabr.length
    ? ` Ayrıca ${sabr.map((r) => r.client).join(', ')} hiç adres vermiyor (SABR).`
    : '';

  if (!addressLocked && !hasToken) {
    return {
      cause: 'pot',
      says: 'Adres hiçbir IP\'ye bağlı değil (ip= parametresi yok), yani proxy de sunucunun '
        + 'adresi de suçlu değil — aynı adres her yerden reddediliyor. Adreste pot= de yok: '
        + 'YouTube proof-of-origin belirteci olmadan medyayı vermiyor. Çözüm çerez kavanozu '
        + '(YT_DLP_COOKIES) ve gerekirse bir PO token sağlayıcısı.' + others,
    };
  }

  return {
    cause: 'unknown',
    says: 'Her yol reddedildi. Adres '
      + (addressLocked ? 'bir IP\'ye bağlı (ip= var)' : 'IP\'ye bağlı değil')
      + ' ve belirteç '
      + (hasToken ? 'mevcut (pot= var)' : 'yok')
      + '. Aşağıdaki durum kodlarına bakmak gerekiyor.' + others,
  };
}

/**
 * The whole check, across every client rather than a sample of them.
 *
 * Checking three of eight and reporting that none worked was a real cost once:
 * the answer may simply be that some client further down the chain is fine, and
 * that is the cheapest fix there is. So the walk covers the lot and stops the
 * moment one of them actually delivers bytes — fast when there is an answer,
 * and slow only in the case where the full picture is what is needed anyway.
 */
const TOTAL_BUDGET_MS = 50000;

async function run(videoId, { all = false } = {}) {
  const active = youtube.activeClient();
  const clients = [...new Set([active, ...youtube.CLIENT_CHAIN])].filter(Boolean);

  const proxy = config.proxyMedia && config.proxyUsableByFfmpeg ? config.proxy : null;

  const rows = [];
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  for (const client of clients) {
    // Always finish the client in hand; never start one there is no time for.
    if (rows.length && Date.now() > deadline && !all) {
      rows.push({ client, skipped: 'süre doldu — tamamı için ?all=1' });
      continue;
    }
    const row = await checkClient(videoId, client, proxy);
    rows.push(row);
    // A working client is the answer; the rest of the chain is academic.
    const best = bestProxyProbe(row);
    if (best && best.ok && !all) break;
  }

  // Only worth the two extra resolves if something is actually failing, and
  // only meaningful against a client that resolves at all.
  const anyWorking = rows.some((r) => {
    const best = bestProxyProbe(r);
    return best && best.ok;
  });
  const resolvable = rows.find((r) => r.resolved);
  const rotation = (config.proxy && !anyWorking && resolvable)
    ? await checkRotation(videoId, resolvable.client)
    : null;

  return {
    videoId,
    activeClient: active,
    proxy: config.maskProxy(config.proxy) || null,
    proxyUsedForMedia: Boolean(proxy),
    cookies: Boolean(config.cookies),
    verdict: verdict(rows, rotation),
    proxyRotation: rotation,
    clients: rows,
  };
}

module.exports = { run, verdict, describeUrl };
