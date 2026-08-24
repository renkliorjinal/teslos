'use strict';

const fs = require('fs');
const path = require('path');

// Minimal .env loader so the project stays dependency-light. Values already
// present in the real environment win, which keeps systemd overrides working.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;

  // Parsed into a map first so a repeated key takes its last value. Appending a
  // corrected line to the bottom of the file is the natural way to fix a
  // setting, and having the stale one silently win is a miserable way to lose
  // an afternoon.
  const parsed = new Map();
  const repeated = new Set();

  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (parsed.has(key)) repeated.add(key);
    parsed.set(key, value);
  }

  for (const key of repeated) {
    console.warn(`[config] ${key} is set more than once in .env; using the last one`);
  }

  // A real environment variable still beats the file.
  for (const [key, value] of parsed) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// setup.sh already recorded the hostname here, so the doctor can print a real
// setup link instead of a placeholder without anyone editing .env by hand.
// Loaded first, so .env and the real environment both still win over it.
loadEnvFile(path.join(__dirname, '..', '.env'));
loadEnvFile('/etc/default/teslos-setup');

// Everything the running service writes — the cookie jar, the Google
// credentials and tokens, probe samples — goes here, and nowhere else.
//
// The unit runs under ProtectSystem=strict, so the install directory is
// genuinely read-only to the service: a write there fails with EROFS rather
// than a permission error, which is a confusing thing to meet on the roadside.
// systemd sets STATE_DIRECTORY from StateDirectory= in the unit; outside
// systemd the project root is the natural place and needs no setting up.
const stateDir = process.env.STATE_DIRECTORY
  || process.env.TESLOS_STATE
  || path.join(__dirname, '..');

try {
  fs.mkdirSync(stateDir, { recursive: true });
} catch (err) {
  console.warn(`[config] state directory ${stateDir} is not usable: ${err.message}`);
}

// A jar placed in the project root by hand still counts. Moving the default
// out from under an existing install should not quietly sign it out.
function cookieJarPath() {
  if (process.env.YT_DLP_COOKIES) return process.env.YT_DLP_COOKIES;
  const legacy = path.join(__dirname, '..', 'cookies.txt');
  if (stateDir !== path.join(__dirname, '..') && fs.existsSync(legacy)) return legacy;
  return path.join(stateDir, 'cookies.txt');
}

// Quality presets. MPEG1 has no modern rate-distortion tricks, so bitrates run
// higher than an H.264 equivalent would at the same resolution.
const QUALITY = {
  360: { scale: '640:360', videoBitrate: '600k' },
  480: { scale: '854:480', videoBitrate: '1000k' },
  720: { scale: '1280:720', videoBitrate: '1800k' },
  1080: { scale: '1920:1080', videoBitrate: '3000k' },
};

const DEFAULT_QUALITY = QUALITY[process.env.DEFAULT_QUALITY] ? Number(process.env.DEFAULT_QUALITY) : 480;

const proxy = (process.env.PROXY_URL || '').trim();

// ffmpeg can only tunnel through an HTTP proxy; its http protocol has no SOCKS
// support. yt-dlp handles both, so the two ends of the pipeline can disagree
// about whether a given proxy is usable.
const proxyUsableByFfmpeg = /^https?:\/\//i.test(proxy);

// A failed write here almost always means the unit predates StateDirectory=,
// so the whole filesystem is read-only to the service. "EROFS" on a phone at
// the roadside is not a diagnosis; the command that fixes it is.
function explainWriteFailure(err) {
  if (err.code !== 'EROFS' && err.code !== 'EACCES') return err.message;
  return `${stateDir} yazılabilir değil — servis dosyası eski. `
    + 'Sunucuda: git pull && sudo cp deploy/teslos.service /etc/systemd/system/ '
    + '&& sudo systemctl daemon-reload && sudo systemctl restart teslos';
}

// Which commit is actually running. Read from .git directly rather than by
// shelling out: the service user cannot always run git against a checkout it
// does not own, and this has to work when it matters — deciding whether the
// thing in the car is the version that was known to work.
function revision() {
  try {
    const head = fs.readFileSync(path.join(__dirname, '..', '.git', 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : null;
    if (!ref) return head.slice(0, 8);
    const sha = fs.readFileSync(path.join(__dirname, '..', '.git', ref), 'utf8').trim();
    return `${ref.replace('refs/heads/', '')}@${sha.slice(0, 8)}`;
  } catch {
    // Packed refs, a tarball deploy, a shallow clone — none of them worth
    // failing a health check over.
    return 'unknown';
  }
}

// Credentials in a proxy URL must never reach a log line or an API response.
function maskProxy(url) {
  if (!url) return '';
  return url.replace(/\/\/[^@/]*@/, '//***@');
}

module.exports = {
  port: Number(process.env.PORT) || 8742,
  bind: process.env.BIND || '127.0.0.1',
  ytDlp: process.env.YT_DLP || 'yt-dlp',
  ffmpeg: process.env.FFMPEG || 'ffmpeg',
  stateDir,
  // Checked on every call rather than read once, so uploading a jar through
  // /setup/ takes effect without a restart.
  cookiesPath: cookieJarPath(),
  get cookies() {
    return fs.existsSync(this.cookiesPath) ? this.cookiesPath : '';
  },
  // The upload endpoint writes a credential to disk on a public host, so it
  // stays off entirely unless a token has been set.
  setupToken: process.env.SETUP_TOKEN || '',
  // Recorded by setup.sh when the certificate was issued. Google's OAuth
  // redirect has to match a registered URI exactly, so it is built from this
  // rather than from whatever Host header a request happens to carry.
  publicHost: (process.env.TESLOS_DOMAIN || '').trim(),
  proxy,
  proxyUsableByFfmpeg,
  // YouTube ties a media URL to the address that asked for it, so by default
  // the media fetch takes the same route the resolve did. Opting out is for
  // metered proxies, and risks 403s on playback.
  proxyMedia: Boolean(proxy) && process.env.PROXY_MEDIA !== '0',
  maskProxy,
  explainWriteFailure,
  revision: revision(),
  maxSessions: Number(process.env.MAX_SESSIONS) || 3,
  publicDir: path.join(__dirname, '..', 'public'),
  reportsDir: path.join(stateDir, 'probe-reports'),
  QUALITY,
  DEFAULT_QUALITY,

  resolveQuality(value) {
    const n = Number(value);
    return QUALITY[n] ? n : DEFAULT_QUALITY;
  },
};
