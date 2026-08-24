# teslos

A YouTube player for the Tesla centre-screen browser, plus a probe that
measures what that browser will and will not do while the car is moving.

> **Note on lawfulness.** A driver watching video while the car is moving is
> illegal in Turkey and most other jurisdictions, and Tesla's lockout exists
> for that reason. Nothing here removes the risk it addresses.

---

## What the car actually does

Tesla blocks video while the car is moving, and the block is subtler than it
first appears: the `<video>` element is **not** paused. Its clock keeps running
and its audio keeps playing — the car simply stops putting its frames on the
screen. So `video.paused` stays `false` throughout and tells you nothing; the
only honest measure is how many frames were actually presented, via
`requestVideoFrameCallback`.

Measured with `/probe/` in a Model 3 on Chromium 140, at 104 km/h:

| Capability | At speed |
|---|---|
| `<video>` frames presented | **none** — clock runs, picture frozen |
| `<video>` paused | `false` — the element is playing |
| `drawImage(video, …)` | black, even parked |
| `<canvas>` + WebGL | works, 60 fps |
| WebCodecs `VideoDecoder` | works, decoded H.264 (`avc1.42C01E`) into a canvas |
| WebSocket, WebAssembly | work |
| WebAudio | clock advances; inaudible while another app holds the speakers |
| `<audio>`, `<video>` audio | play, and claim the car's media source |
| Theater apps (YouTube/Netflix) | gated to Park |

The block therefore lands on the `<video>` element specifically, not on video
data, decoding, or the screen. Anything that reaches the canvas by another
route keeps working.

## The two transports

**canvas** (default) — MPEG1 in an MPEG-TS over a WebSocket, decoded by JSMpeg
in JavaScript and painted into a `<canvas>`:

```
YouTube ──yt-dlp──► ffmpeg ──MPEG1-TS──► WebSocket ──► JSMpeg ──► <canvas>
                       │                                 (JS + WebGL decode)
                       └────MP2 audio muxed into the same transport stream
```

No `<video>` element exists anywhere in it, which is the entire point. It costs
a realtime transcode per viewer and MPEG1 looks poor beside H.264, but it is
what survives the lockout.

**direct** (parked only) — an ordinary `<video>` fed a remuxed MP4, copied from
YouTube's own H.264 and AAC without re-encoding:

```
YouTube ──yt-dlp──► ffmpeg -c copy ──fragmented MP4──► <video>
```

Near-zero server cost, hardware decoding, full quality — and a frozen picture
the moment the car moves. Worth switching to when parked. The player counts
presented frames and falls back to canvas on its own when they stop arriving.

### Audio on the canvas path

The direct path carries its own audio inside the MP4. The canvas path has two
options, and which one works is a property of the car, not of this code:

- **separate** (default) — a plain MP3 body driving an `<audio>` element. A
  media element is the only thing this firmware will actually route to the
  speakers, and it claims the car's media source, so the radio pauses for the
  video and returns afterwards, the way any media app behaves.
- **muxed** — MP2 inside the same transport stream, decoded by JSMpeg into
  WebAudio. One clock, so sync is free. Measured silent on the car tested here:
  no audible output at all while another app held the speakers, though the
  context reported `running` throughout. Kept for firmware that does route it.

The separate path costs a second clock, so **the soundtrack is the master and
the decode loop is slaved to it.** JSMpeg normally decodes one frame per
animation frame, which against 30 fps content on a 60 Hz display wants to run at
double speed: it empties its buffer the moment anything arrives and then sits
starved at the leading edge, so a single network hiccup puts the picture
permanently behind with nothing queued to recover from. Instead, frames are
decoded until the picture reaches where the sound has got to and then not again
until it moves — behind, it catches up as fast as the buffer allows; ahead, it
waits. Sync stops being a correction and becomes a property of the loop.

That only works with something in the buffer, which is why the server paces at
`-readrate 1.5` with an initial burst rather than `-re`. `-re` sends at exactly
1x and never faster, so there is never a cushion to spend.

The surplus has to stop somewhere. The client consumes at 1x, so an ungoverned
over-rate accumulates until the decoder's ring buffer overflows — and it evicts
undecoded frames, so the picture silently jumps ahead of the sound. That is
heard as the audio arriving late, which is nothing like what it is. Three
independent brakes prevent it:

- The client reports the ring's fill fraction, read straight off the buffer, and
  the server stops sending above 60%. No bitrate has to be agreed on.
- It also reports seconds held, as a coarser cross-check.
- The server caps its own lead at 18 s of nominal content, so a page cached from
  before any of this existed still cannot be overrun.

Re-cutting the canvas stream still exists but is a last resort — 5 s out, with a
30 s cooldown — for when the picture is starved rather than merely late.
Restarting the `<audio>` element is never a remedy: that is what seizes the media
source, and doing it to chase sync tore the driver's music away and handed it
back every few seconds. A re-cut is covered by an opaque black panel, because
tearing down the WebGL context makes the car paint the canvas white, which reads
as a fault rather than a pause. The ±0.5 s buttons shift the picture, for the
same reason nothing else does.

Nothing switches paths on its own. Silence is a smaller failure than a media
source changing hands on a loop, so when the muxed path produces nothing the
player says so and leaves the choice on the chip.

Whether sound is reaching the speakers is measured, not inferred: an
`AnalyserNode` is spliced into the output graph and its level is on the
diagnostics panel. The decoder's own `decodedTime` looks like the obvious signal
and is not — it advances happily while decoding into a suspended context, which
is exactly the case where the car is silent.

### Watch history, and picking up where you left off

Nothing played through teslos appears in YouTube's own history, and that is not
an oversight. History is written by YouTube's player sending watch-progress
pings to its own tracking endpoints; yt-dlp fetches media URLs and deliberately
sends none of them, and this server streams those URLs itself. As far as YouTube
is concerned no watch session ever happened. Writing to it would need the cookie
jar plus undocumented internal endpoints — the Data API has no "mark as watched"
call at any scope.

So teslos keeps its own: every video played through it, with the position
reached, in `history.json` under the state directory. That is worse than YouTube's in one way (it only knows what was
watched here) and better in the way that matters in a car: it resumes.

Progress is posted every few seconds rather than at the end, because the end is
exactly what does not happen — the car is switched off, the page is closed, the
link drops. A video opened for under ten seconds is not recorded, and one within
half a minute of either end does not offer to resume. Opening a video with a
stored position resumes there and says so, with a **BAŞTAN OYNAT** button in the
same message.

The **Geçmiş** tab is therefore always on offer, and the grid draws how far into
each video the driver got. When it is empty the picker falls through to the next
tab rather than opening on nothing.

### Losing the connection

The two halves of playback fail very differently, and the asymmetry is the
problem. The soundtrack is an `<audio>` element fed over HTTP and the browser
buffers everything that arrives, so after ten minutes it may hold several
minutes ahead. The picture holds seconds. Left alone, an outage means the sound
plays merrily on over a frozen frame.

A short cut is absorbed: that is what the buffer is built for, and stopping
playback for a two-second hiccup would be a regression. But when the decoder has
had no frame to give for two seconds and nothing has come down the socket for
six, playback **stops** — the soundtrack is paused, an opaque panel says what is
happening, and the position is held.

Recovery retries with a backoff (3 s doubling to 30 s), because reaching this
server is not the same as being able to play: a dead car link fails the check
outright, but a server that cannot reach YouTube answers cheerfully and then
delivers nothing. Only real bytes arriving reset the count. When the stream
comes back, both halves restart from where they stopped.

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

### Backups, and getting back to a working version

Two different things can be lost, and only one of them is in git.

**The code** is. `/api/health` reports `revision` and the server logs it at
startup, so which commit is in the car is never a guess — note it down whenever
playback is confirmed good, and that is the rollback target:

```bash
cd /opt/teslos
sudo git log --oneline -10        # the recent versions
sudo git checkout <commit>        # the one that worked
sudo systemctl restart teslos
```

Back to the current version afterwards:
`sudo git checkout claude/tesla-video-playback-7tkyzo`. Nothing is lost by
checking out an old commit — every version is still there.

**The state** is not, and cannot be re-created: the YouTube cookie jar, the
Google client and its refresh token, and the watch history with every resume
position. Signing in again is a ten-step chore on a phone at the roadside.

```bash
sudo bash deploy/backup.sh                 # take one, keeps the last 10
sudo bash deploy/backup.sh --list          # what is there
sudo bash deploy/backup.sh --restore FILE  # put one back
```

Backups land in `/var/backups/teslos`, owner-only, because they contain a live
session and a refresh token. Restoring stops the service first — it holds those
files open — and sets the current state aside before overwriting, so a restore
is itself reversible. Worth running before every `git pull`.

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

3. **Cookies.** The sturdiest, and the only one that also opens age-restricted
   and members-only videos. Export them from a logged-in browser in Netscape
   format and paste them into **`/setup/`**, which writes the jar owner-only
   and takes effect without a restart — no SSH needed. That page is off unless
   `SETUP_TOKEN` is set, since it writes a live credential on a public host;
   `deploy/setup.sh` mints a token and prints it.

   Export from a **private window** and close it without signing out: signing
   out ends the session and invalidates the jar. Treat the file as a
   credential — it is an active session for that account.

None of this applies to the car itself, which reaches YouTube from a mobile
address and is not challenged.

### Signing in to your own account

Two routes, and they buy different things.

**A cookie jar** is the complete one: watch history, home recommendations,
age-restricted and members-only videos, everything. It also needs a browser
extension on a real computer, which is exactly what you do not have on a road
trip.

**Google OAuth** is the one that works from a phone. `/setup/` walks through
creating a Google Cloud project, enabling *YouTube Data API v3*, and pasting
back the client ID and secret; after that "sign in with Google" is one tap and
an ordinary consent screen. It serves **subscriptions, likes and playlists**.

It does **not** serve watch history or the home feed, and no credential makes
it: Google removed both from the Data API years ago and there is no replacement
endpoint. Watch Later went the same way. If those matter, the cookie jar is the
only answer.

Two things about the consent screen are worth knowing before they surprise you
on the roadside. Google will call the app unverified — it is yours, and
verification is not worth requesting for one user; continue via **Advanced**.
And while the Cloud project sits in *Testing*, Google expires the grant every
seven days, so signing in again is a periodic chore until the project is
published. Your own Google account must be listed under **Test users** or the
consent screen refuses outright.

Both credentials can coexist. The server prefers the jar, falls back to Google
when the jar has lapsed, and the player only shows the tabs that whatever is
configured can actually fill.

Everything either one writes — the jar, the Google client and tokens, probe
samples — lands in `/var/lib/teslos`, which the unit's `StateDirectory=` grants.
The install directory itself is read-only to the service, `ProtectSystem=strict`
included, so a unit file predating that setting fails every save with `EROFS`.
Copy `deploy/teslos.service` again after pulling if `/setup/` says so.

---

## Use

Open `https://your-host/` in the car — that is the player. `/probe/` measures
what the firmware allows; `/setup/` handles both ways of signing in.

1. **`/probe/`** first, to find out what this particular firmware allows.
   Allow the location prompt — GPS speed is how a sample is labelled Park or
   Drive, and inferring that from `<video>` pausing would be circular, since
   that is the thing under test. Press **OTOMATİK RAPOR**, drive, press it
   again; it posts a sample to `probe-reports/` every 20 seconds so nobody has
   to touch the screen while moving. It also measures link speed, which is how
   to pick a quality preset rather than guessing.

   Then `npm run report -- diff` on the server, which pairs the newest Park
   sample with the newest Drive one and says what changed.

2. **The player**, on the bare hostname. Signed in, it opens on your own
   recommendations, with tabs for subscriptions, history, watch later and
   likes; signed out, only trending has anything in it. Search and pasted
   links work either way. Thumbnails load straight from YouTube's CDN rather
   than through the server, so they cost no proxy bandwidth.

   It starts on the canvas transport, since that is the one that survives
   Drive; the **Yol** chip switches to direct, which is better quality but
   only usable parked. **Tanı** shows what the video element is really doing,
   and opens itself when playback stalls.

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
- **A starved picture still costs a re-cut.** The decode loop closes any gap it
  has buffered frames for, but a link too slow to sustain the bitrate runs the
  buffer dry, and then the only remedy is re-opening the stream further on — a
  second of black. Dropping to a lower quality preset is the real fix. The
  WebCodecs transport below removes the cause rather than the symptom: one
  stream, with the `<video>` element as both speaker and clock.
- **yt-dlp is load-bearing.** YouTube changes break it regularly; keep it
  updated.
- **WebCodecs is available and unused.** The probe decodes H.264 through
  `VideoDecoder` into a canvas at speed, which would beat MPEG1 badly at the
  same bitrate and cost the server far less. Replacing the transport with it is
  the obvious next step.
- **WebRTC is available and unused.** `/probe/` reports `RTCPeerConnection` as
  present. Its video normally lands in a `<video>` element, so it would need
  the same canvas treatment to be worth anything here.

## Licence

MIT. Vendored [JSMpeg](https://github.com/phoboslab/jsmpeg) is MIT.
