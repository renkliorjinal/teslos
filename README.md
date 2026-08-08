# teslos

A YouTube player for the Tesla centre-screen browser, plus a probe that
measures what that browser will and will not do while the car is moving.

> **Note on lawfulness.** A driver watching video while the car is moving is
> illegal in Turkey and most other jurisdictions. Current firmware no longer
> stops it, which changes nothing about the risk.

---

## What the car actually does

Older Tesla firmware paused `<video>` elements at the OS level the moment the
car left Park, and a paused element also poisons `drawImage()`, so video frames
could not reach a canvas either. Routing around that is what this project was
built for.

**That restriction is absent on current firmware.** Measured with `/probe/` in a
Model 3 on Chromium 140, at 104 km/h:

| Capability | At speed |
|---|---|
| `<video>` element | **keeps playing** |
| `<canvas>` + WebGL | works, 60 fps |
| WebCodecs `VideoDecoder` | works, decoded H.264 (`avc1.42C01E`) |
| WebSocket, WebAssembly | work |
| WebAudio | works, clock advancing |
| `<audio>` element | works |
| `drawImage(video, …)` | black — even parked |
| Theater apps (YouTube/Netflix) | still gated to Park |

So before installing any of this, **open youtube.com in the car's browser and
press play.** If that works, you do not need this project.

## The two transports

**direct** (default) — an ordinary `<video>` element fed a remuxed MP4. The
server copies YouTube's existing H.264 and AAC into a fragmented container
without re-encoding:

```
YouTube ──yt-dlp──► ffmpeg -c copy ──fragmented MP4──► <video>
```

Near-zero server CPU, hardware decoding, full quality. This is what to use.

**canvas** (fallback) — MPEG1 in an MPEG-TS over a WebSocket, decoded by JSMpeg
in JavaScript and painted into a `<canvas>`:

```
YouTube ──yt-dlp──► ffmpeg ──MPEG1-TS──► WebSocket ──► JSMpeg ──► <canvas>
                       │                                 (JS + WebGL decode)
                       └────MP2 audio muxed into the same transport stream
```

Never touches a `<video>` element, so it survives the old lockout. It costs a
full realtime transcode per viewer and MPEG1 looks poor next to H.264, but on
firmware that still enforces the restriction it is the only thing that works.
The player switches to it automatically if the direct stream never starts.

### Audio on the canvas path

The direct path carries its own audio inside the MP4. The canvas path has two
options, because WebAudio behaviour in Drive varies by firmware:

- **muxed** (default) — MP2 inside the same transport stream, decoded by JSMpeg
  into WebAudio. Shares a clock with the video, so it stays in sync.
- **separate** — a plain MP3 body driving an `<audio>` element. Survives Drive
  on every firmware seen so far, but drifts; the player exposes ±0.5 s nudges.

It starts on *muxed* and falls back to *separate* on its own if the audio
context has not reached `running` within four seconds.

### Networking

Tesla's browser refuses RFC1918 addresses (`192.168.x.x`, `10.x.x.x`,
`172.16–31.x.x`), which rules out pointing the car at a private LAN host. This
repo therefore assumes a public host with a real hostname and certificate — the
car will only open a WebSocket from an HTTPS page, so `wss://` is mandatory.

(An in-car device is still possible; projects like Tesla Android work around the
block by numbering the device out of a non-RFC1918 range such as `3.3.3.1`. That
is not what this repo does.)

---

## Requirements

- Node.js 18+
- ffmpeg with `mpeg1video`, `mp2`, `libmp3lame` and `libx264` encoders
- yt-dlp
- A public hostname with TLS

## Install

On a fresh Debian/Ubuntu droplet, point the hostname's DNS A record at it and
then:

```bash
git clone https://github.com/renkliorjinal/teslos.git /opt/teslos
sudo bash /opt/teslos/deploy/setup.sh tesla.example.com you@example.com
```

That installs the dependencies, the nginx site, a Let's Encrypt certificate and
the systemd service, then runs the pre-flight check. It is safe to re-run.

Manually, if you would rather do it a piece at a time:

```bash
cd /opt/teslos
npm install
cp .env.example .env      # then edit
npm run doctor            # verifies binaries, encoders and a real YouTube resolve
npm start
```

`npm run doctor` is worth running before anything else — every dependency it
checks fails, in the car, as an unexplained black canvas.

### Behind nginx

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/teslos
# edit the server_name, then
sudo ln -s /etc/nginx/sites-available/teslos /etc/nginx/sites-enabled/
sudo certbot --nginx -d tesla.example.com
sudo nginx -t && sudo systemctl reload nginx
```

Two directives in that file are load-bearing: `proxy_buffering off` (otherwise
nginx accumulates the transport stream and adds seconds of latency that never
drain) and the `Upgrade`/`Connection` pair on `/ws/`.

### As a service

```bash
sudo useradd -r -s /usr/sbin/nologin teslos
sudo chown -R teslos:teslos /opt/teslos
sudo cp deploy/teslos.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now teslos
journalctl -u teslos -f
```

### Getting past YouTube's bot check

YouTube answers datacenter addresses with *"Sign in to confirm you're not a
bot"*, which kills every request the server makes. Three ways out, cheapest
first:

1. **Other player clients.** Tried automatically — `tv_simply`, `android_vr`,
   `ios` and `android` need neither authentication nor the JS player, so they
   sidestep the proof-of-origin check. `npm run doctor` names the one that
   worked. Costs nothing, but on a thoroughly flagged address none of them get
   through.

2. **A proxy.** Set `PROXY_URL` to a residential or mobile exit. Both the
   resolve and the media fetch go through it, because YouTube binds each media
   URL to the address that asked for it — split them and the CDN answers 403.
   ffmpeg can only tunnel through an HTTP proxy, so `socks5://` needs a local
   bridge; `npm run doctor` says so plainly rather than letting playback fail
   later.

3. **Cookies.** Export them from a logged-in browser in Netscape format and
   point `YT_DLP_COOKIES` at the file. Treat it as a credential — it is an
   active session for that account. `chmod 600`, and note it is already in
   `.gitignore`.

None of this applies to the car itself, which reaches YouTube from a mobile
address and is not challenged.

---

## Use

Open `https://your-host/` in the car.

1. **`/probe/`** first, to find out what this particular firmware allows.
   Allow the location prompt — GPS speed is how a sample is labelled Park or
   Drive, and inferring that from `<video>` pausing would be circular, since
   that is the thing under test. Press **OTOMATİK RAPOR**, drive, press it
   again; it posts a sample to `probe-reports/` every 20 seconds so nobody has
   to touch the screen while moving. It also measures link speed, which is how
   to pick a quality preset rather than guessing.

   Then `npm run report -- diff` on the server, which pairs the newest Park
   sample with the newest Drive one and says what changed.

2. **`/player/`** to watch. Paste a link or search; tap the picture for
   controls. It starts on the direct transport and drops to canvas by itself
   if that does not play.

### Quality presets

On the **canvas** path these are transcode targets, and MPEG1 needs a lot of
bitrate to look tolerable:

| Preset | Scale | Video | ≈ Total with audio | Data per hour |
|---|---|---|---|---|
| 360p | 640×360 | 600 kbit/s | ~0.7 Mbit/s | ~0.3 GB |
| 480p | 854×480 | 1.0 Mbit/s | ~1.1 Mbit/s | ~0.5 GB |
| 720p | 1280×720 | 1.8 Mbit/s | ~1.9 Mbit/s | ~0.9 GB |
| 1080p | 1920×1080 | 3.0 Mbit/s | ~3.1 Mbit/s | ~1.4 GB |

On the **direct** path the preset only caps which YouTube rendition is picked;
the bitrate is whatever YouTube already encoded, which for H.264 is far less
than the equivalent row above.

480p is the default. Browsing over cellular at all requires Premium
Connectivity — on Wi-Fi it is free.

### Server load

On the direct path each viewer is an ffmpeg process copying packets, which is
cheap enough to ignore. On the canvas path it is a realtime software transcode,
and a 1 vCPU droplet handles roughly one 480p session. `MAX_SESSIONS` (default
2) is the valve either way, and sessions past it are refused with a message
rather than degrading everyone.

---

## Layout

```
server/
  index.js     Express + WebSocket wiring, /ws/video and /ws/speedtest
  routes.js    JSON API, fallback audio, probe fixtures
  stream.js    ffmpeg pipelines and session accounting
  youtube.js   yt-dlp wrapper: id parsing, metadata, format resolution, search
  config.js    env loading and quality presets
  doctor.js    pre-flight dependency check
public/
  probe/       browser capability probe
  player/      the player (vendored JSMpeg, MIT)
deploy/        nginx and systemd templates
```

## Known limitations

- **Seeking past the buffer restarts the stream.** The direct path can seek
  instantly inside what it has already downloaded; beyond that, and always on
  the canvas path, the stream reopens at a new `?t=` offset.
- **Direct seeks land on a keyframe.** Copying rather than re-encoding means the
  cut can only fall on one, so playback may begin slightly before the requested
  point. The player corrects its position display when the browser reports a
  usable duration.
- **MPEG1 is soft-decoded in JavaScript.** Fine at 480p; 1080p leans on both the
  car's CPU and the server's. Only relevant on the canvas path.
- **Separate-audio mode drifts.** Only relevant if WebAudio turns out to be
  suppressed on your firmware.
- **yt-dlp is load-bearing.** YouTube changes break it regularly; keep it
  updated.
- **WebRTC is available and unused.** `/probe/` reports `RTCPeerConnection` as
  present on current firmware. It would be a plausible transport, but with
  `<video>` unrestricted there is nothing left for it to solve.

## Licence

MIT. Vendored [JSMpeg](https://github.com/phoboslab/jsmpeg) is MIT.
