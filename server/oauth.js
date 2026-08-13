'use strict';

/**
 * Signing in to YouTube without a desktop browser.
 *
 * The cookie jar is the complete answer — it is what gives the account's home
 * recommendations and watch history — but producing one needs a browser
 * extension on a real computer. Google's OAuth device-code flow, which yt-dlp
 * once used, has been switched off.
 *
 * What is left is the YouTube Data API, whose consent screen is an ordinary web
 * page: it works from a phone or from the car itself. It cannot reach watch
 * history or the home feed — Google has not exposed those to any API for years
 * — but subscriptions, likes and playlists are most of what discovery is for.
 *
 * Both the client credentials and the tokens live in files rather than in .env,
 * because the whole point is that none of this requires an SSH session.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const ROOT = path.join(__dirname, '..');
const TOKEN_PATH = path.join(ROOT, 'google-tokens.json');
const CLIENT_PATH = path.join(ROOT, 'google-client.json');
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const API = 'https://www.googleapis.com/youtube/v3';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeSecret(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// Environment wins, so an operator with shell access can pin the credentials
// and the setup page cannot then be used to swap them out.
function credentials() {
  const stored = readJson(CLIENT_PATH) || {};
  return {
    clientId: (process.env.GOOGLE_CLIENT_ID || stored.clientId || '').trim(),
    clientSecret: (process.env.GOOGLE_CLIENT_SECRET || stored.clientSecret || '').trim(),
    fromEnv: Boolean(process.env.GOOGLE_CLIENT_ID),
  };
}

function setCredentials(clientId, clientSecret) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  // Google's own format. Checking it here turns a paste of the wrong field into
  // an immediate message rather than an opaque failure on the consent screen.
  if (!/\.apps\.googleusercontent\.com$/.test(id)) {
    throw new Error('İstemci kimliği .apps.googleusercontent.com ile bitmeli');
  }
  if (secret.length < 10) throw new Error('İstemci gizli anahtarı eksik görünüyor');
  writeSecret(CLIENT_PATH, { clientId: id, clientSecret: secret });
}

function configured() {
  const { clientId, clientSecret } = credentials();
  return Boolean(clientId && clientSecret);
}

// Google matches this against the registered redirect character for character,
// so it has to be built from the same hostname the car actually visits.
function redirectUri() {
  const host = config.publicHost;
  if (!host) return null;
  return `https://${host}/api/auth/callback`;
}

function signedIn() {
  const tokens = readJson(TOKEN_PATH);
  return Boolean(tokens && tokens.refresh_token);
}

function signedInAt() {
  const tokens = readJson(TOKEN_PATH);
  return (tokens && tokens.created_at) || null;
}

function forget() {
  try {
    fs.unlinkSync(TOKEN_PATH);
  } catch {
    // Nothing stored.
  }
}

// One-use anti-forgery values. The flow starts and finishes within a minute on
// the same phone, so memory is the right place for them — a restart in between
// simply means starting the sign-in again.
const pending = new Map();

function pruneStates() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [value, at] of pending) {
    if (at < cutoff) pending.delete(value);
  }
}

function authUrl() {
  const { clientId } = credentials();
  const redirect = redirectUri();
  if (!clientId || !redirect) return null;

  pruneStates();
  const state = crypto.randomBytes(16).toString('hex');
  pending.set(state, Date.now());

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPE,
    state,
    // Without both of these Google hands back an access token only, and the
    // sign-in would lapse in an hour with no way to renew it unattended.
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function stateOk(state) {
  pruneStates();
  if (!state || !pending.has(state)) return false;
  pending.delete(state);
  return true;
}

async function exchangeCode(code) {
  const { clientId, clientSecret } = credentials();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });

  const body = await response.json();
  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description || body.error || 'Token alınamadı');
  }
  if (!body.refresh_token) {
    // Without one the sign-in dies in an hour, which would look like a random
    // failure later rather than a mistake made here.
    throw new Error('Google yenileme anahtarı vermedi; izni kaldırıp tekrar dene');
  }

  writeSecret(TOKEN_PATH, {
    refresh_token: body.refresh_token,
    access_token: body.access_token,
    expires_at: Date.now() + (body.expires_in - 60) * 1000,
    created_at: Date.now(),
  });
}

async function accessToken() {
  const tokens = readJson(TOKEN_PATH);
  if (!tokens) throw new Error('YouTube hesabı bağlı değil');
  if (tokens.access_token && Date.now() < tokens.expires_at) return tokens.access_token;

  const { clientId, clientSecret } = credentials();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });

  const body = await response.json();
  if (!response.ok || !body.access_token) {
    // A revoked or expired grant cannot be recovered from, and keeping it would
    // make every later call fail the same way for no reason. Google expires
    // these after a week while the Cloud project is still in Testing.
    if (body.error === 'invalid_grant') {
      forget();
      throw new Error('Google oturumu düştü — /setup/ sayfasından tekrar giriş yap');
    }
    throw new Error(body.error_description || body.error || 'Oturum yenilenemedi');
  }

  tokens.access_token = body.access_token;
  tokens.expires_at = Date.now() + (body.expires_in - 60) * 1000;
  writeSecret(TOKEN_PATH, tokens);
  return tokens.access_token;
}

async function api(endpoint, params) {
  const token = await accessToken();
  const url = `${API}/${endpoint}?${new URLSearchParams(params)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.error && body.error.message;
    if (response.status === 403 && /not been used|disabled/i.test(detail || '')) {
      throw new Error('YouTube Data API bu projede açık değil — Google Cloud\'da etkinleştir');
    }
    throw new Error(detail || `YouTube API ${response.status}`);
  }
  return body;
}

// ISO 8601 durations, which is what the API reports: PT1H2M10S.
function isoDuration(value) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(value || ''));
  if (!m) return 0;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600)
    + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}

function toItem(snippet, videoId) {
  return {
    videoId,
    title: snippet.title || videoId,
    duration: 0,
    uploader: snippet.videoOwnerChannelTitle || snippet.channelTitle || '',
    publishedAt: snippet.publishedAt || '',
  };
}

// Recent uploads across the account's subscriptions. The API has no combined
// subscription feed, so it is assembled: the channels, then each one's uploads
// playlist, merged newest first.
async function subscriptionFeed(limit) {
  const subs = await api('subscriptions', {
    part: 'snippet', mine: 'true', maxResults: '25', order: 'relevance',
  });
  const channelIds = (subs.items || [])
    .map((item) => item.snippet && item.snippet.resourceId && item.snippet.resourceId.channelId)
    .filter(Boolean)
    .slice(0, 12);
  if (!channelIds.length) return [];

  // One call for every uploads-playlist id, rather than one per channel.
  const channels = await api('channels', {
    part: 'contentDetails', id: channelIds.join(','), maxResults: '50',
  });
  const uploadLists = (channels.items || [])
    .map((c) => c.contentDetails
      && c.contentDetails.relatedPlaylists
      && c.contentDetails.relatedPlaylists.uploads)
    .filter(Boolean);

  const perChannel = await Promise.all(uploadLists.map((playlistId) =>
    api('playlistItems', { part: 'snippet', playlistId, maxResults: '3' })
      .then((r) => r.items || [])
      .catch(() => [])));

  const items = perChannel
    .flat()
    .map((item) => toItem(item.snippet, item.snippet.resourceId && item.snippet.resourceId.videoId))
    .filter((item) => item.videoId)
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
    .slice(0, limit);

  return withDurations(items);
}

async function likedFeed(limit) {
  const liked = await api('videos', {
    part: 'snippet,contentDetails', myRating: 'like', maxResults: String(Math.min(limit, 50)),
  });
  return (liked.items || []).map((item) => ({
    ...toItem(item.snippet, item.id),
    duration: isoDuration(item.contentDetails && item.contentDetails.duration),
  }));
}

// The account's own playlists, flattened into whatever they hold. Watch Later
// is deliberately absent: Google removed it from the API years ago and no
// credential brings it back.
async function playlistFeed(limit) {
  const lists = await api('playlists', { part: 'snippet', mine: 'true', maxResults: '10' });
  const ids = (lists.items || []).map((l) => l.id).slice(0, 6);
  if (!ids.length) return [];

  const perList = await Promise.all(ids.map((playlistId) =>
    api('playlistItems', { part: 'snippet', playlistId, maxResults: '8' })
      .then((r) => r.items || [])
      .catch(() => [])));

  const items = perList
    .flat()
    .map((item) => toItem(item.snippet, item.snippet.resourceId && item.snippet.resourceId.videoId))
    .filter((item) => item.videoId)
    .slice(0, limit);

  return withDurations(items);
}

// playlistItems never carries a duration, and a grid without one gives no idea
// whether a tap costs three minutes or three hours. One extra call covers fifty
// videos, so it is worth making.
async function withDurations(items) {
  if (!items.length) return items;
  const ids = items.map((i) => i.videoId).slice(0, 50);
  try {
    const details = await api('videos', { part: 'contentDetails', id: ids.join(',') });
    const byId = new Map((details.items || [])
      .map((v) => [v.id, isoDuration(v.contentDetails && v.contentDetails.duration)]));
    return items.map((item) => ({ ...item, duration: byId.get(item.videoId) || 0 }));
  } catch {
    // A missing badge is not worth failing the whole grid over.
    return items;
  }
}

// Only the feeds the API can actually answer. Watch history and the home page
// are not among them, for any caller, and pretending otherwise would just
// produce an empty grid.
const FEEDS = {
  subscriptions: subscriptionFeed,
  liked: likedFeed,
  playlists: playlistFeed,
};

function feedNames() {
  return Object.keys(FEEDS);
}

function canServe(name) {
  return signedIn() && Object.prototype.hasOwnProperty.call(FEEDS, name);
}

async function feed(name, limit = 24) {
  const count = Math.min(Math.max(Number(limit) || 24, 1), 50);
  return FEEDS[name](count);
}

function status() {
  const { clientId, fromEnv } = credentials();
  return {
    configured: configured(),
    signedIn: signedIn(),
    signedInAt: signedInAt(),
    // Enough to recognise which project is wired up, not enough to reuse it.
    clientIdHint: clientId ? clientId.slice(0, 12) + '…' : '',
    fromEnv,
    redirectUri: redirectUri(),
    feeds: signedIn() ? feedNames() : [],
  };
}

module.exports = {
  configured, signedIn, forget, setCredentials, authUrl, stateOk, exchangeCode,
  redirectUri, canServe, feed, feedNames, status,
};
