'use strict';

/**
 * Tesla-side player.
 *
 * The car's browser pauses <video> elements at the OS level once the car
 * leaves Park, and a paused element also poisons drawImage(), so no pixels can
 * be laundered through one. This player therefore never creates a <video> at
 * all: the server sends MPEG1 in an MPEG-TS over a WebSocket, JSMpeg decodes it
 * in JavaScript, and the frames are painted into a <canvas> via WebGL.
 *
 * Audio has two paths:
 *   muxed    - MP2 inside the same transport stream, decoded by JSMpeg and sent
 *              to WebAudio. Shares a clock with the video, so it stays in sync.
 *   separate - a plain MP3 body driving an <audio> element. Known to survive
 *              Drive mode on every firmware, but drifts against the video.
 * Muxed is preferred and falls back automatically when WebAudio stays silent.
 *
 * Seeking is a server-side operation: there is no buffer to scrub, so a seek
 * tears the socket down and reopens it with a new ?t= offset.
 */

(function () {
  var $ = function (id) { return document.getElementById(id); };

  var el = {
    canvas: $('screen'),
    overlay: $('overlay'),
    query: $('q'),
    go: $('go'),
    results: $('results'),
    bar: $('bar'),
    seek: $('seek'),
    fill: $('fill'),
    knob: $('knob'),
    playPause: $('playPause'),
    time: $('time'),
    title: $('title'),
    qualityBtn: $('qualityBtn'),
    audioBtn: $('audioBtn'),
    libBtn: $('libBtn'),
    nudgeBack: $('nudgeBack'),
    nudgeFwd: $('nudgeFwd'),
    status: $('status'),
    toast: $('toast'),
    audio: $('fallbackAudio')
  };

  var QUALITIES = [360, 480, 720, 1080];

  var state = {
    videoId: null,
    meta: null,
    quality: 480,
    audioMode: 'muxed',
    audioNudge: 0,       // seconds added to the fallback audio request
    player: null,
    playing: false,
    startOffset: 0,      // absolute position the current socket started at
    streamStartedAt: 0,
    scrubbing: false,
    scrubPosition: 0,
    watchdog: null,
    resumeTimer: null
  };

  // ---------------------------------------------------------------- helpers

  function fmtTime(total) {
    if (!isFinite(total) || total < 0) total = 0;
    var s = Math.floor(total % 60);
    var m = Math.floor((total / 60) % 60);
    var h = Math.floor(total / 3600);
    var mm = h > 0 && m < 10 ? '0' + m : String(m);
    var ss = s < 10 ? '0' + s : String(s);
    return (h > 0 ? h + ':' : '') + mm + ':' + ss;
  }

  function setStatus(text) {
    el.status.textContent = text;
  }

  function toast(message) {
    el.toast.textContent = message;
    el.toast.style.display = 'block';
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.toast.style.display = 'none'; }, 6000);
  }

  function currentPosition() {
    if (state.scrubbing) return state.scrubPosition;
    if (!state.player || !state.playing) return state.startOffset;

    var elapsed = 0;
    try {
      elapsed = state.player.currentTime || 0;
    } catch (e) {
      elapsed = 0;
    }
    // Before the first frame decodes, currentTime sits at 0; wall clock keeps
    // the seek bar honest because the server paces the stream at 1x.
    if (!isFinite(elapsed) || elapsed <= 0) {
      elapsed = (performance.now() - state.streamStartedAt) / 1000;
    }
    return state.startOffset + elapsed;
  }

  // ---------------------------------------------------------------- loading

  function loadInput(raw) {
    var value = String(raw || '').trim();
    if (!value) return;

    setStatus('çözümleniyor…');
    el.go.disabled = true;

    fetch('/api/meta?v=' + encodeURIComponent(value))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          openVideo(data);
          return null;
        }
        // Not a recognisable link, so treat what was typed as a search.
        setStatus('aranıyor…');
        return fetch('/api/search?q=' + encodeURIComponent(value))
          .then(function (r) { return r.json(); })
          .then(function (search) {
            if (!search.ok || !search.results.length) {
              toast(search.error || 'Sonuç bulunamadı');
              setStatus('hazır');
              return;
            }
            renderResults(search.results);
            setStatus(search.results.length + ' sonuç');
          });
      })
      .catch(function (err) {
        toast('Hata: ' + err.message);
        setStatus('hata');
      })
      .then(function () { el.go.disabled = false; });
  }

  function renderResults(results) {
    el.results.innerHTML = '';
    results.forEach(function (item) {
      var node = document.createElement('div');
      node.className = 'result';
      node.innerHTML = '<div class="t"><b></b><span></span></div><div class="d"></div>';
      node.querySelector('b').textContent = item.title;
      node.querySelector('span').textContent = item.uploader || '';
      node.querySelector('.d').textContent = item.duration ? fmtTime(item.duration) : 'canlı';
      node.addEventListener('click', function () {
        openVideo({
          videoId: item.videoId,
          title: item.title,
          duration: item.duration,
          isLive: !item.duration,
          uploader: item.uploader
        });
      });
      el.results.appendChild(node);
    });
  }

  function openVideo(meta) {
    state.videoId = meta.videoId;
    state.meta = meta;
    el.title.textContent = meta.title;
    el.overlay.classList.add('hidden');
    el.bar.classList.remove('dim');
    history.replaceState(null, '', '?v=' + meta.videoId);
    start(0);
  }

  // ------------------------------------------------------------- transport

  function teardown() {
    clearTimeout(state.watchdog);
    clearTimeout(state.resumeTimer);
    state.watchdog = null;
    state.resumeTimer = null;

    if (state.player) {
      try {
        state.player.destroy();
      } catch (e) {
        // JSMpeg throws if the socket died first; nothing left to clean up.
      }
      state.player = null;
    }
    el.audio.pause();
    el.audio.removeAttribute('src');
    el.audio.load();
  }

  function start(position) {
    teardown();

    state.startOffset = Math.max(0, position || 0);
    state.streamStartedAt = performance.now();
    state.playing = true;
    el.playPause.textContent = '❚❚';
    setStatus('bağlanılıyor…');

    var muxedAudio = state.audioMode === 'muxed';
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = proto + '//' + location.host + '/ws/video'
      + '?v=' + encodeURIComponent(state.videoId)
      + '&q=' + state.quality
      + '&t=' + Math.floor(state.startOffset)
      + '&audio=' + (muxedAudio ? '1' : '0');

    state.player = new JSMpeg.Player(wsUrl, {
      canvas: el.canvas,
      source: JSMpeg.Source.WebSocket,
      audio: muxedAudio,
      video: true,
      autoplay: true,
      streaming: true,
      // Our own resume logic reopens at the *current* position; JSMpeg's
      // reconnect would reopen the original ?t= and jump backwards.
      reconnectInterval: 0,
      videoBufferSize: 1024 * 1024,
      audioBufferSize: 256 * 1024,
      onSourceEstablished: function () { setStatus('akıyor'); },
      onStalled: function () { setStatus('tampon bekleniyor…'); },
      onEnded: handleEnded
    });

    // A user gesture opened this, so the context is allowed to start.
    if (muxedAudio && state.player.audioOut && state.player.audioOut.context) {
      var ctx = state.player.audioOut.context;
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
    }

    watchSocket();
    if (muxedAudio) armAudioWatchdog();
    else startFallbackAudio();
  }

  // JSMpeg swallows close codes, but the socket object is reachable and the
  // reason string is the only place the server can explain a refusal.
  //
  // Whether the socket exists by the time the constructor returns varies with
  // the JSMpeg build, so poll briefly instead of assuming. Attaching late is
  // harmless; missing the close event entirely leaves the driver staring at a
  // black screen with no explanation.
  function watchSocket() {
    var player = state.player;
    var attempts = 0;

    (function attach() {
      if (state.player !== player) return; // superseded by a newer stream
      var socket = player.source && player.source.socket;
      if (!socket) {
        if (attempts++ < 40) setTimeout(attach, 50);
        return;
      }
      if (socket.__teslosWatched) return;
      socket.__teslosWatched = true;

      var previous = socket.onclose;
      socket.onclose = function (event) {
        if (previous) previous.call(socket, event);
        if (state.player === player) handleClose(event);
      };
    })();
  }

  function handleClose(event) {
    if (!state.playing) return;

    if (event.code >= 4000) {
      state.playing = false;
      el.playPause.textContent = '▶';
      setStatus('durdu');
      toast(event.reason || 'Sunucu akışı reddetti');
      return;
    }

    // 1000 at (or past) the end of a VOD is just the file running out.
    var position = currentPosition();
    var duration = state.meta && state.meta.duration;
    if (duration && position >= duration - 2) {
      handleEnded();
      return;
    }

    setStatus('bağlantı koptu, sürdürülüyor…');
    state.resumeTimer = setTimeout(function () { start(position); }, 1500);
  }

  function handleEnded() {
    state.playing = false;
    el.playPause.textContent = '▶';
    setStatus('bitti');
  }

  // ------------------------------------------------------------------ audio

  function armAudioWatchdog() {
    state.watchdog = setTimeout(function () {
      var out = state.player && state.player.audioOut;
      var ctx = out && out.context;
      var running = ctx && ctx.state === 'running';
      if (running) return;

      // WebAudio is suppressed on this firmware/drive state. The <audio>
      // element path is the documented survivor, so move over to it.
      toast('WebAudio susturuldu — ayrı ses akışına geçiliyor');
      setAudioMode('separate', true);
    }, 4000);
  }

  function startFallbackAudio() {
    var offset = Math.max(0, state.startOffset + state.audioNudge);
    el.audio.src = '/api/audio?v=' + encodeURIComponent(state.videoId)
      + '&t=' + offset.toFixed(2)
      + '&_=' + Date.now();
    el.audio.play().catch(function (err) {
      toast('Ses başlatılamadı: ' + err.name);
    });
  }

  function setAudioMode(mode, restart) {
    state.audioMode = mode;
    el.audioBtn.textContent = 'Ses: ' + (mode === 'muxed' ? 'muxed' : 'ayrı');
    document.body.classList.toggle('separate-audio', mode === 'separate');
    if (restart && state.videoId) start(currentPosition());
  }

  function nudgeAudio(delta) {
    if (state.audioMode !== 'separate') return;
    state.audioNudge += delta;
    setStatus('ses kaydırma: ' + state.audioNudge.toFixed(1) + ' sn');
    // Only the audio stream restarts; the video keeps rolling untouched.
    var elapsed = (performance.now() - state.streamStartedAt) / 1000;
    var offset = Math.max(0, state.startOffset + elapsed + state.audioNudge);
    el.audio.src = '/api/audio?v=' + encodeURIComponent(state.videoId)
      + '&t=' + offset.toFixed(2)
      + '&_=' + Date.now();
    el.audio.play().catch(function () { /* the toast above already covers this */ });
  }

  // --------------------------------------------------------------- controls

  function togglePlay() {
    if (!state.videoId) return;
    if (state.playing) {
      var position = currentPosition();
      teardown();
      state.playing = false;
      state.startOffset = position;
      el.playPause.textContent = '▶';
      setStatus('duraklatıldı');
    } else {
      start(state.startOffset);
    }
  }

  function seekFromEvent(event) {
    var duration = state.meta && state.meta.duration;
    if (!duration) return null;
    var rect = el.seek.getBoundingClientRect();
    var x = (event.touches ? event.touches[0].clientX : event.clientX) - rect.left;
    var ratio = Math.min(1, Math.max(0, x / rect.width));
    return ratio * duration;
  }

  function paintSeek(position) {
    var duration = state.meta && state.meta.duration;
    if (!duration) {
      el.fill.style.width = '100%';
      el.knob.style.left = '100%';
      el.time.textContent = 'CANLI';
      return;
    }
    var ratio = Math.min(1, Math.max(0, position / duration));
    el.fill.style.width = (ratio * 100) + '%';
    el.knob.style.left = (ratio * 100) + '%';
    el.time.textContent = fmtTime(position) + ' / ' + fmtTime(duration);
  }

  function setQuality(quality) {
    state.quality = quality;
    el.qualityBtn.textContent = quality + 'p';
    document.querySelectorAll('.chip[data-q]').forEach(function (chip) {
      chip.classList.toggle('on', Number(chip.dataset.q) === quality);
    });
    if (state.videoId && state.playing) start(currentPosition());
  }

  // ------------------------------------------------------------------ wiring

  el.go.addEventListener('click', function () { loadInput(el.query.value); });
  el.query.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') loadInput(el.query.value);
  });

  document.querySelectorAll('.chip[data-q]').forEach(function (chip) {
    chip.addEventListener('click', function () { setQuality(Number(chip.dataset.q)); });
  });

  el.playPause.addEventListener('click', togglePlay);

  el.qualityBtn.addEventListener('click', function () {
    var next = QUALITIES[(QUALITIES.indexOf(state.quality) + 1) % QUALITIES.length];
    setQuality(next);
  });

  el.audioBtn.addEventListener('click', function () {
    setAudioMode(state.audioMode === 'muxed' ? 'separate' : 'muxed', true);
  });

  el.nudgeBack.addEventListener('click', function () { nudgeAudio(-0.5); });
  el.nudgeFwd.addEventListener('click', function () { nudgeAudio(0.5); });

  el.libBtn.addEventListener('click', function () {
    teardown();
    state.playing = false;
    el.playPause.textContent = '▶';
    el.overlay.classList.remove('hidden');
    el.query.value = '';
    el.results.innerHTML = '';
    setStatus('hazır');
  });

  el.seek.addEventListener('pointerdown', function (event) {
    var position = seekFromEvent(event);
    if (position === null) return;
    state.scrubbing = true;
    state.scrubPosition = position;
    paintSeek(position);
    el.seek.setPointerCapture(event.pointerId);
  });

  el.seek.addEventListener('pointermove', function (event) {
    if (!state.scrubbing) return;
    var position = seekFromEvent(event);
    if (position === null) return;
    state.scrubPosition = position;
    paintSeek(position);
  });

  el.seek.addEventListener('pointerup', function (event) {
    if (!state.scrubbing) return;
    state.scrubbing = false;
    try {
      el.seek.releasePointerCapture(event.pointerId);
    } catch (e) {
      // Capture may already have been released by the browser.
    }
    setStatus('aranıyor…');
    start(state.scrubPosition);
  });

  // Tapping the picture reveals the bar; it fades again once untouched.
  var hideTimer = null;
  function showBar() {
    el.bar.classList.remove('dim');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      if (state.playing) el.bar.classList.add('dim');
    }, 4000);
  }
  el.canvas.addEventListener('pointerdown', showBar);
  el.bar.addEventListener('pointerdown', showBar);

  document.addEventListener('keydown', function (event) {
    if (document.activeElement === el.query) return;
    if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
    if (event.code === 'ArrowRight') start(currentPosition() + 15);
    if (event.code === 'ArrowLeft') start(Math.max(0, currentPosition() - 15));
  });

  window.addEventListener('beforeunload', teardown);

  // -------------------------------------------------------------- main loop

  setInterval(function () { paintSeek(currentPosition()); }, 250);

  // ------------------------------------------------------------------- boot

  fetch('/api/health')
    .then(function (r) { return r.json(); })
    .then(function (health) {
      if (health.defaultQuality) setQuality(health.defaultQuality);
    })
    .catch(function () { setQuality(state.quality); });

  var initial = new URLSearchParams(location.search).get('v');
  if (initial) {
    el.query.value = initial;
    loadInput(initial);
  }

  setAudioMode('muxed', false);
})();
