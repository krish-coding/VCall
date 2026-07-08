# LowBW Call

A minimal 1-to-1 video call app built to survive very slow, unstable networks
(tested against ~800kbps peak with drops to 0kbps).

Two parts:
- `server/` — WebSocket signaling server (Node.js). Tiny, just introduces two
  peers to each other. Never touches audio/video.
- `client/` — Static HTML/JS WebRTC client with the actual low-bandwidth
  logic: hard bitrate caps, audio-priority-over-video, live network stats,
  and auto-recovery when the link drops.

## 1. Run it locally (same wifi, two browser tabs/devices)

```bash
cd server
npm install
npm start
# -> Signaling server listening on port 8080
```

In another terminal, serve the client as static files (any static server works):

```bash
cd client
npx serve -l 3000
# or: python3 -m http.server 3000
```

Open `http://localhost:3000` in two browser tabs (or two devices on the same
network). In both, leave the server URL as `ws://localhost:8080` (or your
machine's LAN IP if testing across two devices), type the same room name in
both, and click "Join call" in each.

You should see your own camera immediately, and the other tab's camera once
both have joined.

## 2. Test it against bad network conditions

Chrome DevTools → Network tab → throttling dropdown → "Custom" → set download
to ~800kbps. To simulate real campus wifi, also try toggling "Offline" on and
off every 10-20 seconds while a call is running — you should see:
- The banner say "video paused to protect audio quality" when bandwidth is tight
- Audio keep working (or gracefully reconnect) through short drops
- The call **not die** when you go offline briefly — it should say
  "reconnecting" and resume when you go back online

If ICE restart doesn't recover after ~10-15s of being back online, that
usually means you need a TURN server (see below) — direct P2P is probably
being blocked by NAT/firewall.

## 3. Deploy for real use (VPS + TURN server)

For this to work from your college network to another network, you need:

1. **A small VPS** — DigitalOcean, Oracle free tier, AWS Lightsail. 1 vCPU /
   1GB RAM is plenty for signaling; TURN relay can use more bandwidth if lots
   of calls need relaying.
2. **The signaling server** running on it (same `server/` code — put it
   behind a process manager like `pm2` so it restarts on crash).
3. **A TURN server** — almost certainly required. Campus networks commonly
   sit behind NAT/firewalls that block direct peer-to-peer UDP, so calls
   will fail to connect without a relay. Install `coturn` (open source,
   standard choice):

```bash
sudo apt install coturn
```

Minimal `/etc/turnserver.conf`:
```
listening-port=3478
fingerprint
lt-cred-mech
user=someuser:somepassword
realm=yourdomain.com
total-quota=100
stale-nonce=600
# For TLS (recommended so campus firewalls don't block plain UDP/3478):
# tls-listening-port=5349
# cert=/path/to/fullchain.pem
# pkey=/path/to/privkey.pem
```

Enable and start:
```bash
sudo systemctl enable coturn
sudo systemctl start coturn
```

Then add it to `CONFIG.iceServers` in `client.js`:
```js
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:your-vps-ip:3478', username: 'someuser', credential: 'somepassword' },
],
```

4. **Serve the client** as static files from the same VPS (nginx is fine),
   or any static host (Vercel/Netlify/GitHub Pages) — it just needs to be
   able to reach your signaling server's WebSocket URL and your TURN server.

5. Use `wss://` (not `ws://`) and put the signaling server behind nginx with
   TLS if deploying publicly — plain `ws://` gets blocked by some networks
   and browsers will refuse mixed content if your site is served over https.

## 4. Tuning for your specific network

Everything that matters is at the top of `client.js` in the `CONFIG` object:

- `videoMaxBitrateKbps` / `audioMaxBitrateKbps` — hard ceilings. Lower these
  further if 800kbps still feels tight in practice (try 80kbps video / 16kbps
  audio).
- `lowBandwidthKbps` / `recoverBandwidthKbps` — thresholds that decide when
  video auto-disables/re-enables. Measure your actual campus wifi's real
  throughput (not the advertised number) and tune these to sit comfortably
  below it.
- `videoWidth` / `videoHeight` / `videoFps` — capture resolution. Smaller
  capture = less encoding work = more headroom under pressure.

## 5. Where to take this next

- Add a **push-to-talk fallback mode** for when even audio struggles —
  half-duplex uses a fraction of the bandwidth of continuous streaming.
- Add **text chat** as a fallback that always works, even when media can't
  get through at all.
- If you want group calls (not just 1:1), you'll need an SFU (Selective
  Forwarding Unit) instead of this direct P2P setup — look at **LiveKit** or
  **mediasoup** self-hosted, both handle per-peer adaptive bitrate for you.
- Log `getStats()` output to your signaling server over time so you can see
  exactly when/how often your campus wifi drops, and tune thresholds against
  real data instead of guesses.
"# VCall" 
