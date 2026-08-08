# teslos

YouTube playback in the Tesla centre-screen browser, rendered to a `<canvas>`
instead of a `<video>` element.

> **Note on lawfulness.** A driver watching video while the car is moving is
> illegal in Turkey and most other jurisdictions, and Tesla's lockout exists
> for that reason. Nothing here removes the risk that restriction addresses.

---

## Why this works

Tesla's browser is an embedded Chromium (QtWebEngine). It stays usable in Drive,
but the car pauses `<video>` elements at the OS level the moment it leaves Park.
A paused element also poisons `drawImage()`, so frames cannot be laundered
through one into a canvas.

The lockout is attached to the **element**, not to the video data. So this
project never creates a `<video>` at all:

```
YouTube ──yt-dlp──► ffmpeg ──MPEG1-TS──► WebSocket ──► JSMpeg ──► <canvas>
                       │                                 (JS + WebGL decode)
                       └────MP2 audio muxed into the same transport stream
```

Measured behaviour of the Tesla browser, from published probes and this repo's
own `/probe/` page:

| Capability | In Drive |
|---|---|
| `<video>` element | paused at OS level, frame frozen |
| `drawImage(video, …)` | black |
| `<canvas>` + WebGL | **works** |
| WebSocket | **works** |
| WebAssembly | **works** |
| `<audio>` element | **works** |
| WebAudio | usually works — `/probe/` confirms per firmware |
| WebCodecs (`VideoDecoder`) | absent |
| Theater apps (YouTube/Netflix) | hard-gated to Park |

MPEG1 is an unfashionable codec, but it is the one JSMpeg can decode in plain
JavaScript at 30 fps, and its inter-frame compression costs roughly a fifth of
what a JPEG frame sequence would.

### Audio

Two paths, because WebAudio behaviour in Drive varies by firmware:

- **muxed** (default) — MP2 inside the same transport stream, decoded by JSMpeg
  into WebAudio. Shares a clock with the video, so it stays in sync.
- **separate** — a plain MP3 body driving an `<audio>` element. Survives Drive
  on every firmware seen so far, but drifts; the player exposes ±0.5 s nudges.

The player starts on *muxed* and falls back to *separate* on its own if the
audio context has not reached `running` within four seconds.

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

```bash
git clone https://github.com/renkliorjinal/teslos.git /opt/teslos
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

### YouTube cookies

YouTube frequently challenges datacenter IPs with *"Sign in to confirm you're
not a bot"*. If `npm run doctor` reports that, export cookies from a logged-in
browser in Netscape format and point `YT_DLP_COOKIES` at the file. Treat that
file as a credential: it is an active session for the account it came from.

---

## Use

Open `https://your-host/` in the car.

1. **`/probe/`** first. Run it parked, then keep the tab open while driving and
   watch three things: does the canvas counter keep climbing, does `<video>`
   drop to `paused = true`, does sound still come out. Those three answers
   decide whether the rest works, and the page uploads a JSON report to
   `probe-reports/`. It also measures the car's actual link speed, which is how
   you pick a quality preset rather than guessing.
2. **`/player/`** to watch. Paste a link or search; tap the picture for
   controls.

### Quality presets

| Preset | Scale | Video | ≈ Total with audio | Data per hour |
|---|---|---|---|---|
| 360p | 640×360 | 600 kbit/s | ~0.7 Mbit/s | ~0.3 GB |
| 480p | 854×480 | 1.0 Mbit/s | ~1.1 Mbit/s | ~0.5 GB |
| 720p | 1280×720 | 1.8 Mbit/s | ~1.9 Mbit/s | ~0.9 GB |
| 1080p | 1920×1080 | 3.0 Mbit/s | ~3.1 Mbit/s | ~1.4 GB |

480p is the default; over the car's LTE it is the sensible ceiling for most
links. Browsing over cellular at all requires Premium Connectivity — on Wi-Fi it
is free.

### Server load

Each viewer is one ffmpeg process doing a realtime software transcode. A 1 vCPU
droplet handles roughly one 480p session; `MAX_SESSIONS` (default 2) is the
valve, and sessions past it are refused with a message rather than degrading
everyone.

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

- **Seeking is a stream restart.** There is no client-side buffer to scrub, so
  a seek tears down the socket and reopens it with a new `?t=` offset. Expect a
  second or two of black.
- **MPEG1 is soft-decoded in JavaScript.** Fine at 480p; 1080p leans on both the
  car's CPU and the server's.
- **Separate-audio mode drifts.** Only relevant if WebAudio turns out to be
  suppressed on your firmware.
- **yt-dlp is load-bearing.** YouTube changes break it regularly; keep it
  updated.
- **Not tested against Tesla firmware 2026.26+**, which opened camera and
  microphone access to the browser. If that release also enabled WebRTC, a much
  simpler transport becomes possible — `/probe/` reports `RTCPeerConnection`
  and will say so.

## Licence

MIT. Vendored [JSMpeg](https://github.com/phoboslab/jsmpeg) is MIT.
