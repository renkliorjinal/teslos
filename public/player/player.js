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
    recut: $('recut'),
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
    // The car decides this, not us: on this firmware WebAudio produces no
    // audible output at all while another app holds the speakers, so the
    // element path — the one Tesla has always been willing to play — is the
    // default. Muxed stays available for firmware that does route WebAudio.
    audioMode: 'separate',
    audioNudge: 0,
    resyncedAt: 0,
    recutUntil: 0,
    recuts: 0,
    bufferSeconds: 0,
    bufferFill: -1,
    resumePoint: 0,
    waiting: false,
    waitingAt: 0,
    lastDataAt: 0,
    lastFrameAt: 0,
    outageTries: 0,
    outageAt: 0,
    reconnectTimer: null,
    progressPostedAt: 0,
    watchedSeconds: 0,
    bitrates: { 360: 600000, 480: 1000000, 720: 1800000, 1080: 3000000 },
    audioStartedAt: 0,
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

  function toast(message, options) {
    el.toast.textContent = message;
    el.toast.style.display = 'block';
    clearTimeout(toast.timer);

    // Some messages are an offer rather than a notice — "resuming, unless you
    // would rather not" — and need somewhere to say no.
    if (options && options.action) {
      var button = document.createElement('button');
      button.className = 'chip';
      button.style.cssText = 'display:block;margin-top:10px;width:100%';
      button.textContent = options.action;
      button.addEventListener('click', function () {
        el.toast.style.display = 'none';
        options.onAction();
      });
      el.toast.appendChild(button);
    }

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

  // Where the soundtrack has actually got to, when there is one running in its
  // own element. It is the master clock: sound cannot be nudged without the car
  // noticing, and the picture can, so everything else is aligned to this.
  function audioClockRunning() {
    return !isDirect() && state.audioMode === 'separate'
      && !el.audio.paused && el.audio.currentTime > 0;
  }

  function masterPosition() {
    if (audioClockRunning()) return state.audioBase + el.audio.currentTime;
    return picturePosition();
  }

  function currentPosition() {
    if (state.scrubbing) return state.scrubPosition;
    if (!state.playing) return state.startOffset;
    return masterPosition();
  }

  // How far the canvas stream itself has run, which is what drifts.
  function picturePosition() {
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
      // History carries a position, and how far in you got is the thing you
      // actually scan for when picking something back up.
      if (item.position > 0 && item.duration) {
        var seen = document.createElement('div');
        seen.className = 'seen';
        var done = document.createElement('i');
        done.style.width = Math.min(100, (item.position / item.duration) * 100) + '%';
        seen.appendChild(done);
        thumb.appendChild(seen);
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

  // `fallbacks` is only used on the opening load: a first tab that turns out to
  // be empty should hand over to the next rather than greeting the driver with
  // nothing. Watch history is the usual reason — it is the right thing to open
  // on once there is something in it, and the wrong thing before.
  function loadFeed(name, fallbacks) {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.classList.toggle('on', tab.dataset.feed === name);
    });
    el.results.innerHTML = '';
    el.feedNote.textContent = 'Yükleniyor…';

    fetch('/api/feed?name=' + encodeURIComponent(name))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) {
          if (fallbacks && fallbacks.length) {
            loadFeed(fallbacks[0], fallbacks.slice(1));
            return;
          }
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
        if (!data.items.length && fallbacks && fallbacks.length) {
          loadFeed(fallbacks[0], fallbacks.slice(1));
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

    // Where this was left last time, if it was. The server keeps the record,
    // because the point is to pick up on whichever screen is to hand.
    state.resumePoint = Math.max(0, Number(meta.resumeAt) || 0);

    if (autostart === false) {
      // No gesture has happened yet, so starting now would play silently and
      // there would be no way to fix it after the fact.
      el.tapTitle.textContent = meta.title;
      el.tapStart.classList.add('on');
      setStatus('başlatmak için dokun');
      return;
    }
    startFromResume();
  }

  function startFromResume() {
    var at = state.resumePoint || 0;
    start(at);
    // Resuming silently would be wrong the one time it is not wanted, and a
    // dialogue before every video would be wrong every other time. So it
    // resumes, and says so, with the way back in the same breath.
    if (at > 0) {
      toast('Kaldığın yerden: ' + fmtTime(at), {
        action: 'BAŞTAN OYNAT',
        onAction: function () {
          state.resumePoint = 0;
          start(0);
        },
      });
    }
  }

  // ------------------------------------------------------------- transport

  // Tearing down the picture, which costs nothing outside this page.
  function teardownPicture() {
    // An interval now, not a timeout — clearTimeout would leave it polling
    // against a player that no longer exists.
    clearInterval(state.watchdog);
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
  }

  // Tearing down the sound, which does not. The <audio> element is what holds
  // the car's media source: stopping it hands the speakers back to Spotify, and
  // starting it takes them again. Every one of those handovers is visible and
  // audible to the driver, so this is called only when the video really changes
  // — never to nudge the picture back into line.
  function teardownAudio() {
    el.audio.pause();
    el.audio.removeAttribute('src');
    el.audio.load();
    state.audioBase = 0;
  }

  function teardown() {
    teardownPicture();
    teardownAudio();
  }

  function start(position) {
    teardown();
    // Only here, never on a re-cut: a re-opened socket that delivers nothing is
    // exactly what an outage looks like, and refreshing this on every attempt
    // let the reconnect loop hide it indefinitely.
    state.lastDataAt = Date.now();
    state.lastFrameAt = Date.now();
    state.waiting = false;
    clearTimeout(state.reconnectTimer);
    el.recut.classList.remove('on');
    el.recut.textContent = 'hizalanıyor…';

    state.startOffset = Math.max(0, position || 0);
    state.streamStartedAt = performance.now();
    state.playing = true;
    el.playPause.textContent = '❚❚';
    setStatus('bağlanılıyor…');

    if (isDirect()) startDirect();
    else startCanvas();
  }

  // Re-cutting the picture to wherever the sound has got to. The soundtrack
  // plays straight through; only the stream feeding the canvas is replaced, so
  // the car's media source is untouched and Spotify stays where it is.
  function resyncPicture() {
    if (isDirect() || !state.playing) return;
    // The nudge is a deliberate offset the driver asked for, so the picture is
    // re-cut to the sound plus that offset rather than straight onto it.
    // Floored, because the server seeks to a whole second: measuring the decode
    // target from an unfloored offset would build in up to a second of error.
    state.startOffset = Math.max(0, Math.floor(masterPosition() + state.audioNudge));
    state.streamStartedAt = performance.now();
    state.resyncedAt = Date.now();
    state.recuts += 1;
    teardownPicture();
    setStatus('görüntü hizalanıyor…');
    el.recut.classList.add('on');
    // A floor as well as a ceiling: whipping the cover away the instant the
    // first frame decodes shows the flash it exists to hide.
    state.recutUntil = Date.now() + 400;
    startCanvas();
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
      // Room for the cushion the server's over-rate builds. The decoder evicts
      // undecoded frames when this overflows, so it has to be larger than the
      // lead the server can get, not merely larger than a hiccup.
      videoBufferSize: 8 * 1024 * 1024,
      audioBufferSize: 512 * 1024,
      onSourceEstablished: function () { setStatus('akıyor'); },
      onStalled: function () { setStatus('tampon bekleniyor…'); },
      onEnded: handleEnded
    });

    if (muxedAudio) {
      unlockAudio();
      attachMeter(state.player.audioOut);
    } else {
      clockPictureToSound(state.player);
    }
    meterSocket(state.player);

    watchSocket();
    if (muxedAudio) {
      armAudioWatchdog();
    } else if (el.audio.paused || !el.audio.getAttribute('src')) {
      // Only when there is no soundtrack running. A re-cut of the picture comes
      // back through here, and starting the element again is the one thing that
      // must not happen — it is what hands the speakers back and forth.
      startFallbackAudio();
    }
  }

  // Frames are decoding again, so the cover has done its job. The delay keeps
  // it up long enough to be a pause rather than a flash.
  function pictureAlive() {
    if (state.waiting) return;
    if (!el.recut.classList.contains('on')) return;
    if (Date.now() < state.recutUntil) return;
    el.recut.classList.remove('on');
    setStatus('akıyor');
  }

  /**
   * Pacing the picture off the soundtrack.
   *
   * JSMpeg decodes exactly one video frame per animation frame, which is what
   * you want when the source is a live camera and the display is the clock. It
   * is wrong here twice over. At 60 Hz against 30 fps content it wants to run at
   * twice real time, so it empties its buffer the instant anything arrives and
   * then sits starved at the leading edge — meaning every network hiccup puts
   * the picture permanently behind, with nothing queued to recover from. And
   * nothing in it knows about the soundtrack, which is playing to its own clock
   * in an <audio> element.
   *
   * So the decode loop is driven by the sound instead: frames are decoded until
   * the picture reaches where the soundtrack has got to, and then not decoded
   * again until it moves. Behind, it catches up as fast as the buffer allows;
   * ahead, it waits. Sync stops being something to correct after the fact and
   * becomes a property of the loop.
   *
   * This replaces one method on the instance rather than taking over the loop,
   * so JSMpeg keeps its own source handling, stall reporting and teardown.
   */
  function clockPictureToSound(player) {
    var wallStart = performance.now();

    player.updateForStreaming = function () {
      if (!this.video) return;

      var waited = performance.now() - wallStart;
      var target;
      if (audioClockRunning()) {
        target = masterPosition() + state.audioNudge - state.startOffset;
      } else if (waited < 5000 && el.audio.getAttribute('src')) {
        // The soundtrack is still opening. Decode enough for a first frame so
        // the screen is not black, then hold — racing ahead on the wall clock
        // and then freezing when the sound arrives looks far worse than a short
        // still.
        target = 0.05;
      } else {
        // No soundtrack coming. The server paces close to real time, so the
        // wall clock is the honest stand-in.
        target = (waited - 5000) / 1000;
      }

      // A cap, so catching up from a long stall cannot lock the main thread for
      // whole seconds. At 60 Hz this still permits about eight times real time,
      // which closes a ten-second gap in under a second of playback.
      var budget = 16;
      var decoded = 0;
      while (this.video.decodedTime < target && budget > 0) {
        if (!this.video.decode()) break;
        decoded += 1;
        budget -= 1;
      }
      if (decoded) {
        // The one unambiguous sign the buffer still has something in it. The
        // seconds-held figure is derived from a nominal bitrate and reads low;
        // this is the decoder itself saying it had a frame to give.
        state.lastFrameAt = Date.now();
        pictureAlive();
      }
    };
  }

  /**
   * Telling the server how much is in hand.
   *
   * ffmpeg sends faster than real time so that a cushion exists, but the decode
   * loop above consumes at exactly the soundtrack's pace. The difference has to
   * be stopped somewhere or it fills the decoder's ring buffer, which then
   * evicts frames that were never shown — the picture jumps forward and the
   * sound is left behind, which is heard as the audio arriving late.
   *
   * The server cannot see any of that, so the client reports it: seconds of
   * content received but not yet decoded, from bytes off the wire against the
   * preset's bitrate. Approximate is fine — it drives a watermark, not a clock.
   */
  var socketBytes = 0;

  // How close the decoder's ring buffer is to evicting frames nobody has seen —
  // read from the buffer itself, so no bitrate has to be guessed at. This is
  // the quantity that actually matters; seconds are only for the human reading
  // the diagnostics panel.
  function ringFill(player) {
    try {
      var bits = player && player.video && player.video.bits;
      if (!bits || !bits.bytes) return -1;
      var unread = bits.byteLength - (bits.index >> 3);
      return Math.min(1, Math.max(0, unread / bits.bytes.length));
    } catch (e) {
      return -1;
    }
  }

  function streamByteRate() {
    var bits = state.bitrates[state.quality] || state.bitrates[480] || 1000000;
    // MPEG-TS spends about 6% on packet headers, and in muxed mode there is an
    // MP2 track in there too.
    var overhead = state.audioMode === 'muxed' ? 128000 : 0;
    return (bits + overhead) * 1.06 / 8;
  }

  function meterSocket(player) {
    socketBytes = 0;
    (function attach(attempts) {
      if (state.player !== player) return;
      var socket = player.source && player.source.socket;
      if (!socket) {
        if (attempts < 40) setTimeout(function () { attach(attempts + 1); }, 50);
        return;
      }
      if (socket.__teslosMetered) return;
      socket.__teslosMetered = true;

      var previous = socket.onmessage;
      socket.onmessage = function (event) {
        var data = event.data;
        socketBytes += (data && (data.byteLength || data.size)) || 0;
        // Doubles as the liveness signal the outage detector reads: a socket
        // that stays open but stops delivering is what a lost link looks like.
        state.lastDataAt = Date.now();
        state.outageTries = 0;
        if (previous) previous.call(socket, event);
      };
    })(0);
  }

  function reportBuffer() {
    var player = state.player;
    if (!player || isDirect()) return;
    var socket = player.source && player.source.socket;
    if (!socket || socket.readyState !== 1) return;

    var decoded = 0;
    try {
      decoded = (player.video && player.video.decodedTime) || 0;
    } catch (e) {
      decoded = 0;
    }
    var received = socketBytes / streamByteRate();
    state.bufferSeconds = Math.max(0, received - decoded);
    state.bufferFill = ringFill(player);

    try {
      socket.send(JSON.stringify({
        buf: Math.round(state.bufferSeconds * 10) / 10,
        fill: state.bufferFill >= 0 ? Math.round(state.bufferFill * 100) / 100 : undefined,
      }));
    } catch (e) {
      // The socket closed between the check and the send; the next tick copes.
    }
  }

  /**
   * Losing the connection.
   *
   * The two halves fail very differently, and that asymmetry is the problem.
   * The soundtrack is an <audio> element fed over HTTP, and the browser buffers
   * as much of it as arrives — after ten minutes it may be holding several
   * minutes ahead. The picture holds seconds. So an outage used to leave the
   * sound playing on merrily over a frozen frame, which is not "carrying on"
   * in any sense the driver would recognise.
   *
   * They should stall together and resume together. When the picture has been
   * starved for long enough to mean something, playback stops — properly, with
   * the soundtrack paused — and waits for the link to come back.
   */
  var OUTAGE_AFTER_MS = 6000;

  function dataArriving() {
    return Date.now() - state.lastDataAt < OUTAGE_AFTER_MS;
  }

  function enterOutage() {
    if (state.waiting || !state.playing) return;
    state.waiting = true;
    // A second outage inside a minute of the last one means the previous
    // attempt achieved nothing, so the next wait should be longer.
    if (Date.now() - state.outageAt < 60000) state.outageTries += 1;
    else state.outageTries = 0;
    state.outageAt = Date.now();
    // The position to come back to, taken before anything is torn down.
    state.waitingAt = masterPosition();

    el.audio.pause();
    el.recut.textContent = state.outageTries > 0
      ? 'Bağlantı bekleniyor… (' + (state.outageTries + 1) + '. deneme)'
      : 'İnternet bekleniyor…';
    el.recut.classList.add('on');
    state.recutUntil = 0;
    setStatus('bağlantı yok');
    teardownPicture();

    pollForConnection();
  }

  // Backing off, because reaching the server is not the same as being able to
  // play. A dead car link fails this outright; a server that cannot reach
  // YouTube answers cheerfully and then delivers nothing, and retrying that
  // every couple of seconds would restart playback over and over instead of
  // waiting. Each failed attempt therefore waits longer, and only real data
  // arriving clears the count.
  function retryDelay() {
    return Math.min(30000, 3000 * Math.pow(2, Math.min(state.outageTries, 4)));
  }

  function pollForConnection() {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(function () {
      if (!state.waiting) return;
      fetch('/api/health', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (health) {
          if (!health || !health.ok) throw new Error('not ready');
          leaveOutage();
        })
        .catch(function () {
          state.outageTries += 1;
          pollForConnection();
        });
    }, retryDelay());
  }

  function leaveOutage() {
    if (!state.waiting) return;
    state.waiting = false;
    clearTimeout(state.reconnectTimer);
    el.recut.classList.remove('on');
    el.recut.textContent = 'hizalanıyor…';
    setStatus('yeniden bağlanılıyor…');
    // Both streams from the same point. The soundtrack's HTTP body died with
    // the link, so it cannot simply be resumed — and restarting it here is
    // right anyway, since playback is already stopped.
    start(state.waitingAt || currentPosition());
  }

  // A dropped link often shows up as an offline event before any timeout does.
  window.addEventListener('offline', function () {
    if (state.playing) enterOutage();
  });

  /**
   * Remembering where this got to.
   *
   * Posted on a timer rather than at the end, because the end is exactly what
   * does not happen — the car is switched off, the page is closed, the link
   * drops. Whatever arrived last is the answer.
   */
  function postProgress(force) {
    if (!state.videoId || !state.meta) return;
    var at = currentPosition();
    if (!force && (!state.playing || state.waiting)) return;
    if (!force && Date.now() - state.progressPostedAt < 10000) return;
    state.progressPostedAt = Date.now();

    var body = JSON.stringify({
      videoId: state.videoId,
      title: state.meta.title,
      duration: state.meta.duration,
      uploader: state.meta.uploader,
      thumbnail: state.meta.thumbnail,
      position: Math.floor(at),
      watched: Math.floor(state.watchedSeconds),
    });

    // sendBeacon survives the page going away, which is the case that matters
    // most and the one fetch() cannot serve.
    if (force && navigator.sendBeacon) {
      try {
        navigator.sendBeacon('/api/progress', new Blob([body], { type: 'application/json' }));
        return;
      } catch (e) {
        // Fall through to fetch.
      }
    }
    fetch('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      keepalive: true,
    }).catch(function () { /* the next tick tries again */ });
  }

  window.addEventListener('pagehide', function () { postProgress(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') postProgress(true);
  });

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
    state.resumeTimer = setTimeout(function () {
      // Nothing has come down the wire for a while, so re-opening it will not
      // help either — and each attempt would restart the clock the outage
      // detector reads, leaving playback churning instead of stopping. The
      // outage is the terminal state of repeated failure, not a rival to it.
      if (!dataArriving()) {
        enterOutage();
        return;
      }
      // A dropped video socket is otherwise a picture problem. Restarting the
      // whole session would take the soundtrack down with it, and the car would
      // hand the speakers back to Spotify for no reason.
      if (audioClockRunning()) {
        state.resyncedAt = 0;
        resyncPicture();
        return;
      }
      start(position);
    }, 1500);
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

  // JSMpeg's own unlock gate is iOS-only — `unlocked` is true from birth on
  // Chromium — so it was never what kept the car silent. The AudioContext is.
  //
  // JSMpeg schedules every buffer at an absolute context time it accumulates
  // itself, and a suspended context's clock does not advance. Feed one while it
  // is suspended and that running total climbs away from the frozen present, so
  // when the context finally starts, everything queued is booked for a moment
  // far in the future: silence, then audio arriving late. That is the delayed
  // sound, and it is caused before the first sample is ever decoded.
  //
  // So the context is created and started at the first touch anywhere on the
  // page, well before a player exists, and handed to JSMpeg as the one it
  // caches. Nothing is ever fed to a stopped clock.
  function webAudioClass() {
    return window.JSMpeg && JSMpeg.AudioOutput && JSMpeg.AudioOutput.WebAudio;
  }

  function primeAudioContext() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var WebAudio = webAudioClass();
    if (!Ctx || !WebAudio) return null;

    if (!WebAudio.CachedContext) WebAudio.CachedContext = new Ctx();
    var ctx = WebAudio.CachedContext;
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
    return ctx;
  }

  function unlockAudio() {
    var ctx = primeAudioContext();
    var out = state.player && state.player.audioOut;

    if (out && ctx && ctx.state !== 'running' && ctx.resume) {
      // Whatever was queued while it was stopped is booked against a clock that
      // never moved, so it would all land at once and late. Resetting drops
      // that backlog and re-bases the schedule on the present.
      ctx.resume().then(function () {
        if (out === (state.player && state.player.audioOut)
          && typeof out.resetEnqueuedTime === 'function') {
          out.resetEnqueuedTime();
        }
      }).catch(function () { /* nothing more to try */ });
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
      // Every gesture, not just the first: a context can be stopped again by
      // the car — a call, another app taking the speakers — and the next touch
      // is the cheapest chance to get it back.
      gestureSeen = true;
      unlockAudio();
    }, true);
  });

  // Listening to the output rather than asking about it.
  //
  // The obvious counter, the MP2 decoder's decodedTime, answers the wrong
  // question. It advances whenever the decoder consumes bytes, and the decoder
  // consumes bytes happily into a suspended AudioContext — which is exactly the
  // case that leaves the car silent. Decoding and being audible come apart
  // precisely where it matters, so a counter cannot tell them apart.
  //
  // An analyser tapped into the output is not a proxy for sound at all — it is
  // the samples themselves, on their way to the speakers.
  var meter = null;

  function attachMeter(out) {
    var ctx = out && out.context;
    if (!ctx || !ctx.createAnalyser || !out.gain) return;

    try {
      // The context is shared across every player, so last time's analyser is
      // still hanging off its destination.
      if (meter) {
        try {
          meter.analyser.disconnect();
        } catch (e) {
          // Already torn down with its player.
        }
        meter = null;
      }

      var analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      // Splice it in: JSMpeg wired gain straight to the speakers, so this sits
      // between them and passes everything through untouched.
      out.gain.disconnect();
      out.gain.connect(analyser);
      analyser.connect(ctx.destination);
      meter = { analyser: analyser, samples: new Float32Array(analyser.fftSize), peak: 0 };
    } catch (e) {
      meter = null;
    }
  }

  // Loudest sample seen since the last look. A quiet passage reads zero, so
  // callers accumulate rather than judging on one glance.
  function audioLevel() {
    if (!meter) return 0;
    meter.analyser.getFloatTimeDomainData(meter.samples);
    var peak = 0;
    for (var i = 0; i < meter.samples.length; i += 8) {
      var v = meter.samples[i] < 0 ? -meter.samples[i] : meter.samples[i];
      if (v > peak) peak = v;
    }
    if (peak > meter.peak) meter.peak = peak;
    return peak;
  }

  function audioQueued() {
    try {
      var out = state.player && state.player.audioOut;
      return (out && out.enqueuedTime) || 0;
    } catch (e) {
      return 0;
    }
  }

  // The watchdog no longer switches paths on its own.
  //
  // The separate stream is an <audio> element, and in the car that claims the
  // media source the way Spotify or the radio would: the console flips over to
  // the browser, and every restart — which drift correction does whenever the
  // picture stutters — flips it again. The driver gets their music torn away
  // and handed back on a loop. Silence is a smaller failure than that, so the
  // switch is now only ever made deliberately, by tapping the chip.
  function armAudioWatchdog() {
    if (meter) meter.peak = 0;
    var polls = 0;

    clearInterval(state.watchdog);
    state.watchdog = setInterval(function () {
      audioLevel();
      polls += 1;
      if (polls < 12) return;                     // ~6s of looking
      clearInterval(state.watchdog);

      if (meter && meter.peak > 0.0005) return;   // sound is reaching the speakers
      if (!meter && audioQueued() > 0) return;    // no analyser; queue is the best proxy

      var ctx = state.player && state.player.audioOut && state.player.audioOut.context;
      if (!gestureSeen || (ctx && ctx.state !== 'running')) {
        toast('Ses için ekrana bir kez dokun');
        return;
      }
      toast('Ses gelmiyor — çubuktaki "ayrı" seçeneği araç medyasını devralır');
    }, 500);
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

  function startFallbackAudio(from) {
    state.audioStartedAt = Date.now();
    var at = from === undefined ? state.startOffset : from;
    state.audioBase = Math.max(0, at - state.audioNudge);
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

  // Holding picture and sound together — by moving the picture.
  //
  // They arrive as two streams with two clocks, so they drift. The old answer
  // was to restart the soundtrack, and that was the whole disaster: each
  // restart seized the car's media source, so Spotify was pushed aside and let
  // back a few seconds later, again and again. Re-cutting the picture costs
  // nothing anyone outside this page can perceive.
  //
  // So the soundtrack is never touched. It runs straight through, holding the
  // speakers for as long as the video lasts, and the picture is re-cut to meet
  // it when it has wandered far enough to notice.
  function holdSync() {
    if (state.audioMode !== 'separate' || isDirect() || !state.playing) return;
    if (state.waiting) return;

    // A soundtrack that has stopped on its own — the stream ended, the link
    // dropped — is already silent, so restarting it costs nothing that has not
    // been lost. This is the only restart left, and it needs a cooldown so a
    // stream that refuses to start does not hammer the media source.
    if (el.audio.paused && el.audio.getAttribute('src')) {
      var duration = state.meta && state.meta.duration;
      var at = picturePosition();
      if (duration && at >= duration - 2) return;
      if (Date.now() - state.audioStartedAt > 8000) startFallbackAudio(at);
      return;
    }

    if (!el.audio.currentTime) return;

    // audioNudge is a deliberate offset the driver asked for; sync preserves it
    // rather than dragging it back to zero and fighting them.
    var drift = picturePosition() - state.audioNudge - masterPosition();
    state.audioDrift = drift;

    // A last resort, not a mechanism. The decode loop is slaved to this same
    // clock, so it closes any gap it has the buffered frames to close; getting
    // here means the picture is starved rather than merely late, and re-cutting
    // is the only thing that helps. Both numbers are deliberately far out — a
    // re-cut is a second of black, and doing it often is worse than being late.
    if (Math.abs(drift) > 5 && Date.now() - state.resyncedAt > 30000) {
      resyncPicture();
    }
  }

  function setAudioMode(mode, restart) {
    // Said once, when it is chosen, because the symptom — the console jumping
    // to the browser and back — looks like a fault rather than a consequence.
    if (mode === 'separate' && state.audioMode !== 'separate') {
      toast('Ayrı ses aracın medya kaynağını devralır; radyo/Spotify duraklar');
    }
    state.audioMode = mode;
    el.audioMuxed.classList.toggle('live', mode === 'muxed');
    el.audioSep.classList.toggle('live', mode === 'separate');
    document.body.classList.toggle('separate-audio', mode === 'separate');
    if (restart && state.videoId) start(currentPosition());
  }

  // Sync is held automatically, so this only moves the point it aims at — for
  // when the automatic result is right by the clock but wrong by eye. It shifts
  // the picture, because the picture is the half that can be moved silently.
  function nudgeAudio(delta) {
    if (state.audioMode !== 'separate' || isDirect()) return;
    state.audioNudge += delta;
    setStatus('görüntü kaydırma: ' + state.audioNudge.toFixed(1) + ' sn');
    // Straight away rather than at the next drift check, and past the cooldown:
    // the driver is watching for the result of the button they just pressed.
    state.resyncedAt = 0;
    resyncPicture();
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
    startFromResume();
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
        // The only line here that reports sound rather than intent: it is
        // measured off the samples on their way to the speakers. decodedTime is
        // deliberately absent — JSMpeg leaves it at zero on a live stream, so
        // reading it says nothing at all.
        'audio level ' + (meter
          ? audioLevel().toFixed(4) + ' (peak ' + meter.peak.toFixed(4) + ')'
          : 'no meter'),
        'audio queued' + ' ' + (out && out.enqueuedTime !== undefined
          ? out.enqueuedTime.toFixed(2) + 's' : '—'),
        'audio elem  ' + (el.audio.paused ? 'paused' : 'playing at ' + el.audio.currentTime.toFixed(1) + 's')
          + ' x' + el.audio.playbackRate.toFixed(2),
        // Positive means the picture is ahead of the sound. The decode loop is
        // slaved to the sound, so this should hover near zero; a growing
        // negative number means the buffer is starved, not that sync is broken.
        'sync        ' + (state.audioDrift === undefined ? '—' : state.audioDrift.toFixed(2) + 's')
          + '  picture ' + picturePosition().toFixed(1) + 's'
          + '  sound ' + masterPosition().toFixed(1) + 's',
        'buffer      ' + state.bufferSeconds.toFixed(1) + 's held'
          + (state.bufferFill >= 0
            ? ', ring ' + Math.round(state.bufferFill * 100) + '%' : ''),
        're-cuts     ' + state.recuts
          + (state.resyncedAt ? ', last ' + Math.round((Date.now() - state.resyncedAt) / 1000) + 's ago' : '')
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
    if (++driftTick % 4 === 0) holdSync();
    if (driftTick % 2 === 0) reportBuffer();
    if (driftTick % 4 === 0) postProgress(false);

    // Nothing arriving, and the buffer that was supposed to cover for that has
    // run dry — the decoder has had no frame to give for two seconds. Until
    // then the cushion is doing its job and playback carries on, which is the
    // whole reason for building one.
    if (state.playing && !state.waiting && !isDirect()
      && !dataArriving() && Date.now() - state.lastFrameAt > 2000) {
      enterOutage();
    }

    if (!state.playing) { stuckSince = 0; return; }

    // For the direct path, progress means frames on the screen. Watching the
    // clock instead would call the lockout healthy, since it keeps ticking.
    var now = isDirect() ? presentedFrames() : currentPosition();
    if (Math.abs(now - lastSeen) > 0.05) {
      if (!state.waiting) state.watchedSeconds += 0.25;
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
      if (health.bitrates) state.bitrates = health.bitrates;

      if (health.cookies) el.signedIn.textContent = 'YouTube: çerez girişi';
      else if (health.google) el.signedIn.textContent = 'YouTube: Google girişi';
      else el.signedIn.textContent = 'YouTube: giriş yok';

      var kept = applyFeeds(health.feeds);
      // Open on the richest list this server can actually fill, falling through
      // any that turn out to be empty.
      if (!initial) loadFeed(kept[0] || 'trending', kept.slice(1));
    })
    .catch(function () { setQuality(state.quality); });

  setTransport('canvas', false);
  setAudioMode(state.audioMode, false);

  if (initial) {
    el.query.value = initial;
    // Reached by link, so no gesture has happened: prepare everything and wait
    // for the tap rather than starting muted.
    loadInput(initial, false);
  }
})();
