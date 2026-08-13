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

loadEnvFile(path.join(__dirname, '..', '.env'));

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
  // Checked on every call rather than read once, so uploading a jar through
  // /setup/ takes effect without a restart.
  cookiesPath: process.env.YT_DLP_COOKIES || path.join(__dirname, '..', 'cookies.txt'),
  get cookies() {
    return fs.existsSync(this.cookiesPath) ? this.cookiesPath : '';
  },
  // The upload endpoint writes a credential to disk on a public host, so it
  // stays off entirely unless a token has been set.
  setupToken: process.env.SETUP_TOKEN || '',
  proxy,
  proxyUsableByFfmpeg,
  // YouTube ties a media URL to the address that asked for it, so by default
  // the media fetch takes the same route the resolve did. Opting out is for
  // metered proxies, and risks 403s on playback.
  proxyMedia: Boolean(proxy) && process.env.PROXY_MEDIA !== '0',
  maskProxy,
  maxSessions: Number(process.env.MAX_SESSIONS) || 3,
  publicDir: path.join(__dirname, '..', 'public'),
  reportsDir: path.join(__dirname, '..', 'probe-reports'),
  QUALITY,
  DEFAULT_QUALITY,

  resolveQuality(value) {
    const n = Number(value);
    return QUALITY[n] ? n : DEFAULT_QUALITY;
  },
};
