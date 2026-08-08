'use strict';

/**
 * Tesla-side player, with two transports.
 *
 * direct — an ordinary <video> fed a remuxed MP4. The server copies YouTube's
 *   existing H.264 into a container without re-encoding, so the car decodes in
 *   hardware at full quality and the server does almost no work.
 *
 * canvas — MPEG1 in an MPEG-TS over a WebSocket, decoded by JSMpeg in
 *   JavaScript and painted into a <canvas>. Uglier, heavier at both ends, and
 *   originally the only option: firmware used to pause <video> elements at the
 *   OS level once the car left Park, and a paused element also poisons
 *   drawImage(), so pixels had to reach the page without touching one.
 *
 * Measured at 104 km/h on Chromium 140 firmware, <video> keeps playing, so
 * direct is the default. The canvas path stays because that lockout may still
 * exist on older firmware, and the player falls back to it on its own if the
 * video element never starts advancing.
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
    results: $('results'),
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
    transport: 'direct',
    audioMode: 'muxed',
    audioNudge: 0,
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

    // If the car does still pause <video> — older firmware than the one this
    // was measured on — nothing ever advances and the screen simply sits
    // there. Rather than leave the driver guessing, take the hint and move to
    // the transport that was built for exactly that case.
    state.directWatchdog = setTimeout(function () {
      if (!state.playing || !isDirect()) return;
      if (el.video.currentTime > 0.3) return;
      toast('Doğrudan oynatma başlamadı — canvas yoluna geçiliyor');
      setTransport('canvas', true);
    }, 12000);
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
      if (ctx && ctx.state === 'running') return;

      // WebAudio is suppressed on this firmware/drive state. The <audio>
      // element path is the documented survivor, so move over to it.
      toast('WebAudio susturuldu — ayrı ses akışına geçiliyor');
      setAudioMode('separate', true);
    }, 4000);
  }

  function fallbackAudioUrl(offset) {
    return '/api/audio?v=' + encodeURIComponent(state.videoId)
      + '&t=' + Math.max(0, offset).toFixed(2)
      + '&_=' + Date.now();
  }

  function startFallbackAudio() {
    el.audio.src = fallbackAudioUrl(state.startOffset + state.audioNudge);
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
    if (state.audioMode !== 'separate' || isDirect()) return;
    state.audioNudge += delta;
    setStatus('ses kaydırma: ' + state.audioNudge.toFixed(1) + ' sn');
    // Only the audio stream restarts; the video keeps rolling untouched.
    var elapsed = (performance.now() - state.streamStartedAt) / 1000;
    el.audio.src = fallbackAudioUrl(state.startOffset + elapsed + state.audioNudge);
    el.audio.play().catch(function () { /* the toast above already covers this */ });
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
    el.results.innerHTML = '';
    setStatus('hazır');
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

  // -------------------------------------------------------------- main loop

  setInterval(function () { paintSeek(currentPosition()); }, 250);

  // ------------------------------------------------------------------- boot

  fetch('/api/health')
    .then(function (r) { return r.json(); })
    .then(function (health) {
      if (health.defaultQuality) setQuality(health.defaultQuality);
    })
    .catch(function () { setQuality(state.quality); });

  setTransport('direct', false);
  setAudioMode('muxed', false);

  var initial = new URLSearchParams(location.search).get('v');
  if (initial) {
    el.query.value = initial;
    loadInput(initial);
  }
})();
