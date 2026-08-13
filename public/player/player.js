'use strict';

/**
 * Tesla-side player, with two transports.
 *
 * canvas (default) — MPEG1 in an MPEG-TS over a WebSocket, decoded by JSMpeg in
 *   JavaScript and painted into a <canvas>. No <video> element appears anywhere
 *   in it, which is the whole point: Tesla stops presenting a <video>'s frames
 *   once the car moves, leaving the element playing — clock running, audio out
 *   — behind a frozen picture. Confirmed at 104 km/h.
 *
 * direct — an ordinary <video> fed a remuxed MP4, copied from YouTube's own
 *   H.264 without re-encoding. Hardware decoding, full quality, almost no
 *   server cost, and useless the moment the car moves. Worth switching to when
 *   parked; the player counts presented frames and returns to canvas by itself
 *   when they stop arriving.
 *
 * Seeking is a server-side operation on both paths: a piped fragmented MP4
 * carries no index and a live socket has no buffer to scrub, so a seek past
 * what is already buffered reopens the stream at a new ?t= offset.
 */

(function () {
  var $ = function (id) { return document.getElementById(id); };

  var el = {
    canvas: $('screen'),
    video: $('direct'),
    overlay: $('overlay'),
    query: $('q'),
    go: $('go'),
    pasteBtn: $('pasteBtn'),
    results: $('results'),
    tabs: $('tabs'),
    feedNote: $('feedNote'),
    signedIn: $('signedIn'),
    bar: $('bar'),
    seek: $('seek'),
    fill: $('fill'),
    knob: $('knob'),
    playPause: $('playPause'),
    time: $('time'),
    title: $('title'),
    qualityBtn: $('qualityBtn'),
    transportBtn: $('transportBtn'),
    audioBtn: $('audioBtn'),
    audioMuxed: $('audioMuxed'),
    audioSep: $('audioSep'),
    libBtn: $('libBtn'),
    tapStart: $('tapStart'),
    tapBtn: $('tapBtn'),
    tapTitle: $('tapTitle'),
    diag: $('diag'),
    diagBtn: $('diagBtn'),
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
    // Canvas by default. Tesla's Drive lockout leaves a <video> element playing
    // — clock running, audio out — and simply stops putting its frames on the
    // screen, so the direct path is dead the moment the car moves. Decoding in
    // JavaScript and painting into a canvas is the point of this project.
    transport: 'canvas',
    audioMode: 'muxed',
    audioNudge: 0,
    audioBase: 0,          // absolute position the fallback audio stream began at
    player: null,          // JSMpeg instance, canvas transport only
    playing: false,
    startOffset: 0,        // absolute position the current stream started at
    streamStartedAt: 0,
    scrubbing: false,
    scrubPosition: 0,
    watchdog: null,
    resumeTimer: null,
    directWatchdog: null
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

    // When YouTube has refused the server, the car itself is not blocked — it
    // reaches YouTube from a mobile address rather than a datacenter one, and
    // current firmware no longer stops <video> from playing. Offer that route
    // instead of leaving a dead end, and leave it up rather than timing out.
    if (/bot|cookie|çerez/i.test(message)) {
      var link = document.createElement('a');
      link.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(state.videoId || '');
      link.textContent = 'YouTube\'u doğrudan aç →';
      link.style.cssText = 'display:block;margin-top:10px;color:#7fd6ff;font-weight:600';
      el.toast.appendChild(document.createElement('br'));
      el.toast.appendChild(link);
      return;
    }

    toast.timer = setTimeout(function () { el.toast.style.display = 'none'; }, 6000);
  }

  function isDirect() {
    return state.transport === 'direct';
  }

  // Counts frames the compositor actually showed. Under the Drive lockout this
  // stays at zero while currentTime climbs, which is the one signal that tells
  // the two situations apart.
  var directFrames = 0;

  function watchDirectFrames() {
    if (typeof el.video.requestVideoFrameCallback !== 'function') {
      // Without rVFC, decoded-frame counts are the next best thing.
      directFrames = -1;
      return;
    }
    var tick = function () {
      directFrames++;
      if (isDirect() && state.playing) el.video.requestVideoFrameCallback(tick);
    };
    el.video.requestVideoFrameCallback(tick);
  }

  function presentedFrames() {
    if (directFrames >= 0) return directFrames;
    if (typeof el.video.getVideoPlaybackQuality === 'function') {
      return el.video.getVideoPlaybackQuality().totalVideoFrames;
    }
    return -1;
  }

  function currentPosition() {
    if (state.scrubbing) return state.scrubPosition;
    if (!state.playing) return state.startOffset;

    var elapsed = 0;
    if (isDirect()) {
      elapsed = el.video.currentTime || 0;
    } else {
      try {
        elapsed = state.player ? state.player.currentTime || 0 : 0;
      } catch (e) {
        elapsed = 0;
      }
      // Before the first frame decodes currentTime sits at 0; wall clock keeps
      // the seek bar honest because the server paces that stream at 1x.
      if (!isFinite(elapsed) || elapsed <= 0) {
        elapsed = (performance.now() - state.streamStartedAt) / 1000;
      }
    }
    return state.startOffset + elapsed;
  }

  // ---------------------------------------------------------------- loading

  function loadInput(raw, autostart) {
    if (autostart === undefined) autostart = true;
    var value = String(raw || '').trim();
    if (!value) return;

    setStatus('çözümleniyor…');
    el.go.disabled = true;

    fetch('/api/meta?v=' + encodeURIComponent(value))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          openVideo(data, autostart);
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
            el.feedNote.textContent = '';
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

  // A grid of thumbnails, because picking a video from a list of titles on a car
  // screen is worse than useless. Thumbnails come straight from YouTube's CDN
  // rather than through this server: the car can reach it perfectly well, and
  // routing them through a metered proxy would cost real money for pictures.
  function renderResults(items, emptyText) {
    el.results.innerHTML = '';
    if (!items.length) {
      el.feedNote.textContent = emptyText || 'Bu listede video yok.';
      return;
    }

    items.forEach(function (item) {
      var card = document.createElement('div');
      card.className = 'card';

      var thumb = document.createElement('div');
      thumb.className = 'thumb';
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = 'https://i.ytimg.com/vi/' + item.videoId + '/mqdefault.jpg';
      thumb.appendChild(img);
      if (item.duration) {
        var len = document.createElement('span');
        len.className = 'len';
        len.textContent = fmtTime(item.duration);
        thumb.appendChild(len);
      }

      var meta = document.createElement('div');
      meta.className = 'meta';
      var title = document.createElement('b');
      title.textContent = item.title;
      var who = document.createElement('span');
      who.textContent = item.uploader || '';
      meta.appendChild(title);
      meta.appendChild(who);

      card.appendChild(thumb);
      card.appendChild(meta);
      card.addEventListener('click', function () {
        // Reached by tapping, so a gesture has happened and audio can start.
        openVideo({
          videoId: item.videoId,
          title: item.title,
          duration: item.duration,
          isLive: !item.duration,
          uploader: item.uploader
        }, true);
      });
      el.results.appendChild(card);
    });
  }

  // Tabs the server cannot answer are removed rather than left to fail: on a
  // car screen a tab that always errors is worse than no tab.
  function applyFeeds(available) {
    var offered = available && available.length ? available : ['trending'];
    var kept = [];
    document.querySelectorAll('.tab').forEach(function (tab) {
      if (offered.indexOf(tab.dataset.feed) === -1) tab.remove();
      else kept.push(tab.dataset.feed);
    });
    return kept;
  }

  function loadFeed(name) {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.classList.toggle('on', tab.dataset.feed === name);
    });
    el.results.innerHTML = '';
    el.feedNote.textContent = 'Yükleniyor…';

    fetch('/api/feed?name=' + encodeURIComponent(name))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) {
          // Everything but Popüler is account-specific, so an unsigned server
          // has nothing to show. Point at the fix rather than an empty grid.
          el.feedNote.innerHTML = '';
          el.feedNote.appendChild(document.createTextNode(data.error + ' '));
          if (/giriş|oturum|sign in|bot/i.test(data.error)) {
            var link = document.createElement('a');
            link.href = '/setup/';
            link.textContent = 'YouTube girişi yap →';
            el.feedNote.appendChild(link);
          }
          return;
        }
        el.feedNote.textContent = '';
        renderResults(data.items, 'Bu listede video yok.');
      })
      .catch(function (err) { el.feedNote.textContent = 'Hata: ' + err.message; });
  }

  function openVideo(meta, autostart) {
    state.videoId = meta.videoId;
    state.meta = meta;
    el.title.textContent = meta.title;
    el.overlay.classList.add('hidden');
    el.bar.classList.remove('dim');
    history.replaceState(null, '', '?v=' + meta.videoId);

    if (autostart === false) {
      // No gesture has happened yet, so starting now would play silently and
      // there would be no way to fix it after the fact.
      el.tapTitle.textContent = meta.title;
      el.tapStart.classList.add('on');
      setStatus('başlatmak için dokun');
      return;
    }
    start(0);
  }

  // ------------------------------------------------------------- transport

  function teardown() {
    clearTimeout(state.watchdog);
    clearTimeout(state.resumeTimer);
    clearTimeout(state.directWatchdog);
    state.watchdog = null;
    state.resumeTimer = null;
    state.directWatchdog = null;

    if (state.player) {
      try {
        state.player.destroy();
      } catch (e) {
        // JSMpeg throws if the socket died first; nothing left to clean up.
      }
      state.player = null;
    }

    el.video.pause();
    el.video.removeAttribute('src');
    el.video.load();

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

    if (isDirect()) startDirect();
    else startCanvas();
  }

  function startDirect() {
    el.canvas.classList.add('off');
    el.video.classList.remove('off');

    el.video.src = '/api/stream?v=' + encodeURIComponent(state.videoId)
      + '&q=' + state.quality
      + '&t=' + Math.floor(state.startOffset);
    el.video.play().catch(function (err) {
      // NotSupportedError here usually means the body was not video at all but
      // the server's JSON explanation. The error handler below digs that out,
      // so say nothing that would talk over it.
      if (err.name !== 'NotSupportedError') toast('Oynatma reddedildi: ' + err.name);
    });

    // The lockout does not stop the clock, so a running currentTime proves
    // nothing — under it the element plays happily and paints nothing. Frames
    // reaching the screen is the only thing worth waiting for.
    directFrames = 0;
    watchDirectFrames();

    state.directWatchdog = setTimeout(function () {
      if (!state.playing || !isDirect()) return;
      if (directFrames > 2) return;
      toast(el.video.currentTime > 1
        ? 'Görüntü ekrana basılmıyor (Drive kilidi) — canvas yoluna geçiliyor'
        : 'Doğrudan oynatma başlamadı — canvas yoluna geçiliyor');
      setTransport('canvas', true);
    }, 10000);
  }

  function startCanvas() {
    el.video.classList.add('off');
    el.canvas.classList.remove('off');

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
      // The server paces at 1x, so the client never gets ahead and has only
      // what has arrived to play from. Room to absorb a few seconds of jitter
      // is the difference between a wobbly link and a stuttering picture.
      videoBufferSize: 4 * 1024 * 1024,
      audioBufferSize: 512 * 1024,
      onSourceEstablished: function () { setStatus('akıyor'); },
      onStalled: function () { setStatus('tampon bekleniyor…'); },
      onEnded: handleEnded
    });

    // A user gesture opened this, so the context is allowed to start.
    if (muxedAudio) unlockAudio();

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

  // Opening the player from a ?v= link starts playback with no user gesture at
  // all, and no browser will let audio out until there has been one. Both audio
  // paths are therefore silent for reasons that have nothing to do with the
  // car, which is worth distinguishing from the ones that do.
  var gestureSeen = false;

  function unlockAudio() {
    // JSMpeg has its own gate on top of the AudioContext, and it caches one
    // context across every player it creates — so a context that was born
    // suspended before the first tap is inherited by everything afterwards.
    // Resuming without also calling unlock() leaves JSMpeg believing it is
    // still muted.
    var out = state.player && state.player.audioOut;
    if (out) {
      var ctx = out.context;
      if (ctx && ctx.state === 'suspended' && ctx.resume) ctx.resume();
      if (typeof out.unlock === 'function' && !out.unlocked) {
        try {
          out.unlock(function () { /* JSMpeg flips its own flag */ });
        } catch (e) {
          // Older builds without the gate.
        }
      }
    }

    if (state.audioMode === 'separate' && el.audio.getAttribute('src') && el.audio.paused) {
      el.audio.play().catch(function () { /* the hint below already covers it */ });
    }
    if (isDirect() && state.playing && el.video.paused) {
      el.video.play().catch(function () { /* likewise */ });
    }
    if (el.toast.textContent.indexOf('dokun') !== -1) el.toast.style.display = 'none';
  }

  ['pointerdown', 'click', 'touchstart', 'keydown'].forEach(function (name) {
    document.addEventListener(name, function () {
      if (gestureSeen) return;
      gestureSeen = true;
      unlockAudio();
    });
  });

  function audioDecodedTime() {
    try {
      return (state.player && state.player.audio && state.player.audio.decodedTime) || 0;
    } catch (e) {
      return 0;
    }
  }

  // Whether the muxed path is working is a question about sound coming out, not
  // about what the AudioContext reports. Judging it on context state alone
  // abandoned a perfectly good stream — running and unlocked — for the drifting
  // fallback, which is the worse of the two. So watch the decoder: if it is
  // chewing through audio, leave it alone.
  function armAudioWatchdog() {
    var startedAt = audioDecodedTime();

    state.watchdog = setTimeout(function () {
      unlockAudio();

      state.watchdog = setTimeout(function () {
        if (audioDecodedTime() > startedAt + 0.5) return;   // audio is flowing

        var out = state.player && state.player.audioOut;
        var ctx = out && out.context;
        if (ctx && ctx.state === 'running' && audioDecodedTime() > 0) return;

        // Without a gesture nothing will play on any path, so switching would
        // swap one silence for another.
        if (!gestureSeen) {
          toast('Ses için ekrana bir kez dokun');
          return;
        }

        toast('Ses çözülmüyor — ayrı ses akışına geçiliyor');
        setAudioMode('separate', true);
      }, 6000);
    }, 4000);
  }

  function fallbackAudioUrl(offset) {
    return '/api/audio?v=' + encodeURIComponent(state.videoId)
      + '&t=' + Math.max(0, offset).toFixed(2)
      + '&_=' + Date.now();
  }

  // A media element reports every failure the same opaque way, so a server-side
  // refusal — no capacity, YouTube saying no — arrives as a codec complaint.
  // The real reason is in the body it declined to play.
  function explainMediaFailure(url, fallback) {
    var controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then(function (response) {
        var type = response.headers.get('content-type') || '';
        if (type.indexOf('json') === -1) {
          controller.abort();
          toast(fallback);
          return null;
        }
        return response.json();
      })
      .then(function (body) {
        if (body && body.error) toast(body.error);
      })
      .catch(function (err) {
        if (err.name !== 'AbortError') toast(fallback);
      });
  }

  function startFallbackAudio() {
    state.audioBase = Math.max(0, state.startOffset - state.audioNudge);
    var url = fallbackAudioUrl(state.audioBase);
    el.audio.src = url;
    el.audio.playbackRate = 1;
    el.audio.play().catch(function (err) {
      // AbortError only means this play() was superseded by the next one —
      // a seek or a restart — which is not something to report.
      if (err.name === 'AbortError') return;
      if (err.name === 'NotSupportedError') explainMediaFailure(url, 'Ses akışı oynatılamadı');
      else toast('Ses başlatılamadı: ' + err.name);
    });
  }

  // The fallback runs as its own stream with its own clock, so it drifts from
  // the picture — and manual nudge buttons are no way to hold sync while
  // driving. Small errors are absorbed by playing fractionally fast or slow,
  // which is inaudible; only a gap too large to close that way restarts it.
  function correctAudioDrift() {
    if (state.audioMode !== 'separate' || isDirect()) return;
    if (!state.playing || el.audio.paused || !el.audio.currentTime) return;

    // audioNudge is a deliberate offset the driver asked for; the correction
    // holds that, rather than dragging it back to zero and fighting them.
    var videoAt = currentPosition() - state.audioNudge;
    var audioAt = state.audioBase + el.audio.currentTime;
    var drift = videoAt - audioAt;
    state.audioDrift = drift;

    if (Math.abs(drift) > 4) {
      startFallbackAudio();
      return;
    }
    if (Math.abs(drift) < 0.15) {
      el.audio.playbackRate = 1;
      return;
    }
    // Positive drift means the audio is behind, so let it run a little faster.
    el.audio.playbackRate = drift > 0 ? 1.04 : 0.96;
  }

  function setAudioMode(mode, restart) {
    state.audioMode = mode;
    el.audioMuxed.classList.toggle('live', mode === 'muxed');
    el.audioSep.classList.toggle('live', mode === 'separate');
    document.body.classList.toggle('separate-audio', mode === 'separate');
    if (restart && state.videoId) start(currentPosition());
  }

  // Sync is corrected automatically, so this only moves the point it aims at —
  // for when the automatic result is right by the clock but wrong by ear.
  function nudgeAudio(delta) {
    if (state.audioMode !== 'separate' || isDirect()) return;
    state.audioNudge += delta;
    setStatus('ses kaydırma: ' + state.audioNudge.toFixed(1) + ' sn');
  }

  // --------------------------------------------------------------- controls

  function setTransport(transport, restart) {
    state.transport = transport;
    el.transportBtn.textContent = 'Yol: ' + (transport === 'direct' ? 'doğrudan' : 'canvas');
    document.body.classList.toggle('canvas-transport', transport === 'canvas');
    if (restart && state.videoId) start(currentPosition());
  }

  function togglePlay() {
    if (!state.videoId) return;

    if (state.playing) {
      // The direct path has a real buffer, so pausing it keeps that buffer;
      // tearing the stream down would throw the buffer away.
      if (isDirect()) {
        el.video.pause();
        state.playing = false;
        state.startOffset = state.startOffset + el.video.currentTime;
        // currentTime is now folded into startOffset, so do not count it twice.
        el.video.currentTime = 0;
      } else {
        var position = currentPosition();
        teardown();
        state.playing = false;
        state.startOffset = position;
      }
      el.playPause.textContent = '▶';
      setStatus('duraklatıldı');
      return;
    }

    if (isDirect() && el.video.src && el.video.readyState > 0) {
      el.video.play();
      state.playing = true;
      el.playPause.textContent = '❚❚';
      setStatus('akıyor');
      return;
    }
    start(state.startOffset);
  }

  function seekFromEvent(event) {
    var duration = state.meta && state.meta.duration;
    if (!duration) return null;
    var rect = el.seek.getBoundingClientRect();
    var x = (event.touches ? event.touches[0].clientX : event.clientX) - rect.left;
    var ratio = Math.min(1, Math.max(0, x / rect.width));
    return ratio * duration;
  }

  // Within what the direct path has already downloaded, a seek is instant and
  // costs the server nothing. Only jumps beyond the buffer need a new stream.
  function seekTo(target) {
    if (isDirect() && el.video.readyState > 0) {
      var wanted = target - state.startOffset;
      var ranges = el.video.buffered;
      for (var i = 0; i < ranges.length; i++) {
        if (wanted >= ranges.start(i) && wanted <= ranges.end(i) - 0.5) {
          el.video.currentTime = wanted;
          setStatus('akıyor');
          return;
        }
      }
    }
    setStatus('aranıyor…');
    start(target);
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

  // The car's browser is signed in to YouTube even though this server is not,
  // so browsing there and handing the link over is the one route to a personal
  // feed without a cookie jar. Reading the clipboard directly saves the
  // fiddliest part of that on a touchscreen.
  el.pasteBtn.addEventListener('click', function () {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      el.query.focus();
      toast('Bu tarayıcı panoyu okuyamıyor — adresi kutuya yapıştır');
      return;
    }
    navigator.clipboard.readText()
      .then(function (text) {
        var value = String(text || '').trim();
        if (!value) {
          toast('Pano boş');
          return;
        }
        el.query.value = value;
        loadInput(value);
      })
      .catch(function () {
        el.query.focus();
        toast('Panoya erişim reddedildi — adresi kutuya yapıştır');
      });
  });
  el.query.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') loadInput(el.query.value);
  });

  document.querySelectorAll('.chip[data-q]').forEach(function (chip) {
    chip.addEventListener('click', function () { setQuality(Number(chip.dataset.q)); });
  });

  el.tapBtn.addEventListener('click', function () {
    el.tapStart.classList.remove('on');
    start(0);
  });

  el.playPause.addEventListener('click', togglePlay);

  el.qualityBtn.addEventListener('click', function () {
    var next = QUALITIES[(QUALITIES.indexOf(state.quality) + 1) % QUALITIES.length];
    setQuality(next);
  });

  el.transportBtn.addEventListener('click', function () {
    setTransport(isDirect() ? 'canvas' : 'direct', true);
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
    setStatus('hazır');
  });

  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () { loadFeed(tab.dataset.feed); });
  });

  // Copying a stream instead of re-encoding it means the cut can only land on
  // a keyframe, so the server may start a little earlier than asked. Left
  // uncorrected the seek bar reads ahead of the picture by up to one keyframe
  // interval. When the browser reports a finite duration the true start is
  // recoverable — total length minus what remains — and when it does not, the
  // requested offset stands as the best estimate available.
  el.video.addEventListener('loadedmetadata', function () {
    var total = state.meta && state.meta.duration;
    var remaining = el.video.duration;
    if (!total || !isFinite(remaining) || remaining <= 0) return;

    var actualStart = total - remaining;
    // Only trust a correction that moves the start backwards by a sane amount;
    // anything else means the duration is not what we think it is.
    if (actualStart >= -1 && actualStart <= state.startOffset + 1) {
      state.startOffset = Math.max(0, actualStart);
    }
  });

  el.video.addEventListener('playing', function () { setStatus('akıyor'); });
  el.video.addEventListener('waiting', function () { setStatus('tampon bekleniyor…'); });
  el.video.addEventListener('ended', handleEnded);
  // A <video> element reports every failure as the same opaque error, so a
  // server-side problem — YouTube refusing the request, say — surfaces as
  // "NotSupportedError" and sends the driver looking at the wrong thing. The
  // server's actual explanation is sitting in the body the element declined to
  // play, so go and read it.
  el.video.addEventListener('error', function () {
    if (!state.playing || !isDirect()) return;

    var fallback = function (message) {
      toast(message);
      setTransport('canvas', true);
    };

    var controller = new AbortController();
    fetch(el.video.currentSrc || el.video.src, { signal: controller.signal })
      .then(function (response) {
        var type = response.headers.get('content-type') || '';
        if (type.indexOf('json') === -1) {
          // Really is video, so the car could not decode it. Canvas can.
          controller.abort();
          fallback('Doğrudan akış oynatılamadı — canvas yoluna geçiliyor');
          return null;
        }
        return response.json();
      })
      .then(function (body) {
        if (!body) return;
        // A server-side refusal will fail the canvas path identically, so
        // switching transports would only hide the reason.
        state.playing = false;
        el.playPause.textContent = '▶';
        setStatus('durdu');
        toast(body.error || 'Sunucu akışı reddetti');
      })
      .catch(function (err) {
        if (err.name === 'AbortError') return;
        fallback('Doğrudan akış hatası — canvas yoluna geçiliyor');
      });
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
    seekTo(state.scrubPosition);
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
  el.video.addEventListener('pointerdown', showBar);
  el.bar.addEventListener('pointerdown', showBar);

  document.addEventListener('keydown', function (event) {
    if (document.activeElement === el.query) return;
    if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
    if (event.code === 'ArrowRight') seekTo(currentPosition() + 15);
    if (event.code === 'ArrowLeft') seekTo(Math.max(0, currentPosition() - 15));
  });

  window.addEventListener('beforeunload', teardown);

  // ------------------------------------------------------------ diagnostics
  //
  // A stalled <video> looks identical from the outside whatever the cause —
  // frozen picture, no sound — while the element itself knows exactly which
  // stage it is stuck at. Guessing from the symptom wastes drives; readyState,
  // networkState, the buffered ranges and the event trail name it outright.

  var READY = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
  var NETWORK = ['EMPTY', 'IDLE', 'LOADING', 'NO_SOURCE'];
  var MEDIA_ERROR = ['', 'ABORTED', 'NETWORK', 'DECODE', 'SRC_NOT_SUPPORTED'];

  var events = [];
  [
    'loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough',
    'play', 'playing', 'waiting', 'stalled', 'suspend', 'progress', 'error', 'ended',
  ].forEach(function (name) {
    el.video.addEventListener(name, function () {
      events.push(name);
      if (events.length > 8) events.shift();
    });
  });

  function bufferedRanges() {
    var b = el.video.buffered;
    if (!b || !b.length) return 'none';
    var out = [];
    for (var i = 0; i < b.length; i++) {
      out.push(b.start(i).toFixed(1) + '–' + b.end(i).toFixed(1));
    }
    return out.join(' ');
  }

  function diagText() {
    var v = el.video;
    var lines = [
      'transport   ' + state.transport,
      'status      ' + el.status.textContent,
      'startOffset ' + state.startOffset.toFixed(1) + 's',
    ];

    if (isDirect()) {
      lines.push(
        'readyState  ' + v.readyState + ' ' + (READY[v.readyState] || '?'),
        'network     ' + v.networkState + ' ' + (NETWORK[v.networkState] || '?'),
        'paused      ' + v.paused,
        'currentTime ' + v.currentTime.toFixed(2) + 's',
        'duration    ' + (isFinite(v.duration) ? v.duration.toFixed(1) + 's' : String(v.duration)),
        'buffered    ' + bufferedRanges(),
        // Zero here while currentTime climbs is the lockout, not a stall.
        'shown frames' + ' ' + presentedFrames(),
        'frame size  ' + v.videoWidth + 'x' + v.videoHeight,
        'error       ' + (v.error ? (MEDIA_ERROR[v.error.code] || v.error.code) + ': ' + v.error.message : 'none'),
        'events      ' + events.join(' → ')
      );
    } else {
      var decoded = '?';
      try {
        decoded = state.player ? state.player.currentTime.toFixed(2) + 's' : 'no player';
      } catch (e) {
        decoded = 'unavailable';
      }
      var socket = state.player && state.player.source && state.player.source.socket;
      var out = state.player && state.player.audioOut;
      lines.push(
        'jsmpeg time ' + decoded,
        'socket      ' + (socket ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][socket.readyState] : 'none'),
        'audio mode  ' + state.audioMode,
        'audio ctx   ' + (out && out.context ? out.context.state : 'none')
          + (out ? (out.unlocked ? ' unlocked' : ' LOCKED') : ''),
        // Silence with a running context means nothing is being decoded into
        // it, which is a different problem from a muted output.
        'audio dec   ' + (state.player && state.player.audio
          ? (state.player.audio.decodedTime || 0).toFixed(2) + 's'
          : 'no decoder'),
        'audio queued' + ' ' + (out && out.enqueuedTime !== undefined
          ? out.enqueuedTime.toFixed(2) + 's' : '—'),
        'audio elem  ' + (el.audio.paused ? 'paused' : 'playing at ' + el.audio.currentTime.toFixed(1) + 's')
          + ' x' + el.audio.playbackRate.toFixed(2),
        'audio drift ' + (state.audioDrift === undefined ? '—' : state.audioDrift.toFixed(2) + 's')
      );
    }
    return lines.join('\n');
  }

  function showDiag(on) {
    el.diag.classList.toggle('on', on);
    if (on) el.diag.textContent = diagText();
  }

  el.diagBtn.addEventListener('click', function () {
    showDiag(!el.diag.classList.contains('on'));
  });

  // -------------------------------------------------------------- main loop

  var lastSeen = -1;
  var stuckSince = 0;

  var driftTick = 0;
  setInterval(function () {
    paintSeek(currentPosition());
    if (el.diag.classList.contains('on')) el.diag.textContent = diagText();
    if (++driftTick % 4 === 0) correctAudioDrift();

    if (!state.playing) { stuckSince = 0; return; }

    // For the direct path, progress means frames on the screen. Watching the
    // clock instead would call the lockout healthy, since it keeps ticking.
    var now = isDirect() ? presentedFrames() : currentPosition();
    if (Math.abs(now - lastSeen) > 0.05) {
      lastSeen = now;
      stuckSince = 0;
      return;
    }

    // Claiming to play while nothing has advanced for six seconds is a stall,
    // whatever the element says. Put the numbers on screen rather than leaving
    // a still frame and no explanation.
    if (!stuckSince) stuckSince = Date.now();
    if (Date.now() - stuckSince > 6000 && !el.diag.classList.contains('on')) {
      setStatus('takıldı');
      showDiag(true);
    }
  }, 250);

  // ------------------------------------------------------------------- boot

  var initial = new URLSearchParams(location.search).get('v');

  fetch('/api/health')
    .then(function (r) { return r.json(); })
    .then(function (health) {
      if (health.defaultQuality) setQuality(health.defaultQuality);

      if (health.cookies) el.signedIn.textContent = 'YouTube: çerez girişi';
      else if (health.google) el.signedIn.textContent = 'YouTube: Google girişi';
      else el.signedIn.textContent = 'YouTube: giriş yok';

      var kept = applyFeeds(health.feeds);
      // Open on the richest list this server can actually fill.
      if (!initial) loadFeed(kept[0] || 'trending');
    })
    .catch(function () { setQuality(state.quality); });

  setTransport('canvas', false);
  setAudioMode('muxed', false);

  if (initial) {
    el.query.value = initial;
    // Reached by link, so no gesture has happened: prepare everything and wait
    // for the tap rather than starting muted.
    loadInput(initial, false);
  }
})();
