'use strict';

/**
 * What was watched, and how far.
 *
 * YouTube's own watch history is reachable only with a cookie jar — Google
 * exposes it to no API, so a phone sign-in cannot produce it. This is the
 * substitute, and for the thing that actually matters in a car it is better
 * than the original: it records a position, so a video resumes where it was
 * left rather than at the beginning.
 *
 * One JSON file. It is a list of watched videos on a single-user box, not a
 * database, and it has to survive nothing more demanding than a restart.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = path.join(config.stateDir, 'history.json');
const LIMIT = 200;

// A video opened and abandoned in the first few seconds was a mistake, not
// something to remember.
const MIN_WATCHED_S = 10;

// Near either end there is nothing to resume to: the start is the start, and
// the last half-minute means it was finished.
const MIN_RESUME_S = 30;
const END_MARGIN_S = 30;

let entries = null;
let writeTimer = null;

function load() {
  if (entries) return entries;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    entries = Array.isArray(parsed) ? parsed : [];
  } catch {
    entries = [];
  }
  return entries;
}

// Debounced: progress arrives every few seconds per viewer, and none of it is
// worth an fsync of its own.
function save() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      fs.writeFileSync(FILE, JSON.stringify(entries || [], null, 1), { mode: 0o600 });
    } catch (err) {
      console.warn(`[history] could not write ${FILE}: ${config.explainWriteFailure(err)}`);
    }
  }, 3000);
  writeTimer.unref();
}

function find(videoId) {
  return load().find((item) => item.videoId === videoId) || null;
}

function record({ videoId, title, duration, uploader, thumbnail, position, watched }) {
  if (!videoId) return null;
  const list = load();
  const at = Math.max(0, Number(position) || 0);
  const total = Math.max(0, Number(duration) || 0);

  let entry = find(videoId);
  if (!entry) {
    // Only once it has been watched for long enough to have been meant.
    if ((Number(watched) || at) < MIN_WATCHED_S) return null;
    entry = { videoId, firstSeenAt: Date.now() };
    list.unshift(entry);
  } else {
    // Newest first, so a rewatch moves it back to the top.
    const index = list.indexOf(entry);
    if (index > 0) {
      list.splice(index, 1);
      list.unshift(entry);
    }
  }

  if (title) entry.title = title;
  if (uploader) entry.uploader = uploader;
  if (thumbnail) entry.thumbnail = thumbnail;
  if (total) entry.duration = total;
  entry.position = at;
  entry.updatedAt = Date.now();
  // Finished videos should not offer to resume thirty seconds from the end.
  entry.finished = Boolean(total && at >= total - END_MARGIN_S);

  if (list.length > LIMIT) list.length = LIMIT;
  save();
  return entry;
}

// Where to pick a video up, or 0 for the beginning.
function resumeAt(videoId) {
  const entry = find(videoId);
  if (!entry || entry.finished) return 0;
  const at = Number(entry.position) || 0;
  if (at < MIN_RESUME_S) return 0;
  if (entry.duration && at > entry.duration - END_MARGIN_S) return 0;
  return Math.floor(at);
}

// Shaped like a feed, so the picker renders it with the same grid as the rest.
function list(limit = 24) {
  const count = Math.min(Math.max(Number(limit) || 24, 1), LIMIT);
  return load().slice(0, count).map((entry) => ({
    videoId: entry.videoId,
    title: entry.title || entry.videoId,
    duration: entry.duration || 0,
    uploader: entry.uploader || '',
    thumbnail: entry.thumbnail || '',
    position: entry.position || 0,
    finished: Boolean(entry.finished),
    updatedAt: entry.updatedAt || 0,
  }));
}

function clear() {
  entries = [];
  save();
}

function forget(videoId) {
  const list_ = load();
  const index = list_.findIndex((item) => item.videoId === videoId);
  if (index === -1) return false;
  list_.splice(index, 1);
  save();
  return true;
}

module.exports = { record, resumeAt, list, clear, forget, FILE };
