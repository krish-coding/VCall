// ===================================================================
// LowBW Call client
//
// Design principles:
//   1. Audio is sacred, always. It gets bandwidth priority no matter what.
//   2. Video quality is ADAPTIVE, not fixed. On a good link (like a real
//      college wifi with a few Mbps) it should look good — sharp, smooth,
//      full resolution. On a bad link it should shrink itself down through
//      quality tiers, and only fully disable as a last resort.
//   3. We continuously measure the link's actual available bandwidth
//      (WebRTC's own congestion-control estimate, not just what we happen
//      to be sending) and pick the best quality tier that fits it.
//   4. Total link death (0kbps) is normal, not fatal — reconnect, don't end
//      the call.
//   5. Changes are made with hysteresis (require sustained good/bad
//      readings) so quality doesn't flicker up and down every couple of
//      seconds.
// ===================================================================

const $ = (id) => document.getElementById(id);

const els = {
  serverUrl: $('serverUrl'),
  roomId: $('roomId'),
  joinBtn: $('joinBtn'),
  leaveBtn: $('leaveBtn'),
  banner: $('banner'),
  localVideo: $('localVideo'),
  remoteVideo: $('remoteVideo'),
  connDot: $('connDot'),
  connLabel: $('connLabel'),
  linkDot: $('linkDot'),
  linkText: $('linkText'),
  statVideo: $('statVideo'),
  statAudioKbps: $('statAudioKbps'),
  statVideoKbps: $('statVideoKbps'),
  statLoss: $('statLoss'),
  statRtt: $('statRtt'),
  statJitter: $('statJitter'),
  statTier: $('statTier'),
  statAvailBw: $('statAvailBw'),
  micBtn: $('micBtn'),
  camBtn: $('camBtn'),
  fullscreenBtn: $('fullscreenBtn'),
  videosContainer: $('videosContainer'),
  callStage: $('callStage'),
  micIconOn: $('micIconOn'),
  micIconOff: $('micIconOff'),
  camIconOn: $('camIconOn'),
  camIconOff: $('camIconOff'),
  fsIconEnter: $('fsIconEnter'),
  fsIconExit: $('fsIconExit'),
};

// ---- Quality tiers, best to worst. -----------------------------------
// scaleResolutionDownBy divides the captured resolution (see CAPTURE
// below) — e.g. 640x480 captured with scaleResolutionDownBy=2 sends
// roughly 320x240. This lets us change quality instantly via
// RTCRtpSender.setParameters() without re-requesting the camera.
const QUALITY_TIERS = [
  { label: 'HD',      minAvailKbps: 1400, videoBitrateKbps: 900, scaleResolutionDownBy: 1,   maxFramerate: 30 },
  { label: 'High',    minAvailKbps: 700,  videoBitrateKbps: 450, scaleResolutionDownBy: 1,    maxFramerate: 24 },
  { label: 'Medium',  minAvailKbps: 300,  videoBitrateKbps: 220, scaleResolutionDownBy: 1.5,  maxFramerate: 20 },
  { label: 'Low',     minAvailKbps: 120,  videoBitrateKbps: 110, scaleResolutionDownBy: 2,    maxFramerate: 15 },
  { label: 'Minimal', minAvailKbps: 40,   videoBitrateKbps: 50,  scaleResolutionDownBy: 4,    maxFramerate: 10 },
];
// Below QUALITY_TIERS[last].minAvailKbps, video gets disabled entirely and
// only audio continues.

const CAPTURE = {
  // Capture at the highest resolution we'd ever want to send (HD tier).
  // Lower tiers downscale from this via scaleResolutionDownBy rather than
  // re-requesting the camera at a different resolution.
  width: 1280,
  height: 720,
  fps: 30,
};

const CONFIG = {
  audioMaxBitrateKbps: 32,   // Opus — plenty for clear speech, negligible cost
  audioMinBitrateKbps: 6,    // floor Opus can drop to under real pressure

  statsIntervalMs: 2000,
  upgradeStreakNeeded: 3,    // ~6s of sustained headroom before going up a tier
  downgradeStreakNeeded: 2,  // ~4s of sustained shortage before dropping a tier
  disableVideoStreakNeeded: 3,
  recoverFromDisabledStreakNeeded: 3,
  highLossPct: 8,            // packet loss % above this -> downgrade a tier immediately

  // Grace period after ICE reaches "connected" before we trust bandwidth
  // estimates. GCC (WebRTC's congestion control) starts conservative and
  // ramps up over a few seconds even on a fast link — without this, a
  // great connection gets misjudged as bad during startup.
  warmupGraceMs: 6000,

  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // Add your TURN server here once deployed — REQUIRED for most campus
    // networks, since they commonly block direct P2P / UDP hole punching:
    // { urls: 'turn:your-turn-server:3478', username: 'user', credential: 'pass' },
  ],
};

let ws = null;
let pc = null;
let localStream = null;
let role = null; // 'offerer' | 'answerer'
let room = null;
let statsTimer = null;
let videoEnabled = true;
let currentTierIndex = 0; // 0 = best quality (HD)
let upgradeStreak = 0;
let downgradeStreak = 0;
let disableStreak = 0;
let recoverStreak = 0;
let wsReconnectAttempts = 0;
let manuallyLeft = false;
let connectionEstablishedAt = null; // set when ICE first reaches 'connected'/'completed'
let smoothedAvailKbps = null;
let micMuted = false;
let userVideoOff = false; // manual camera-off, distinct from network-forced video-off

function setBanner(text, show = true) {
  els.banner.textContent = text;
  els.banner.classList.toggle('show', show);
}

function setLinkStatus(state, text) {
  // state: 'good' | 'warn' | 'bad' | 'idle'
  els.linkDot.className = 'status-dot' + (state !== 'idle' ? ' ' + state : '');
  els.connDot.className = 'status-dot' + (state !== 'idle' ? ' ' + state : '');
  els.linkText.textContent = text;
  els.connLabel.textContent = text;
}

// ---------------------------------------------------------------------
// Signaling (WebSocket) with reconnect-with-backoff
// ---------------------------------------------------------------------
function connectSignaling() {
  const url = els.serverUrl.value.trim();
  ws = new WebSocket(url);

  ws.onopen = () => {
    wsReconnectAttempts = 0;
    ws.send(JSON.stringify({ type: 'join', room }));
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'joined':
        role = msg.role;
        setLinkStatus('warn', `waiting for other peer (you are ${role})`);
        break;

      case 'room-full':
        setBanner('Room is full. Try a different room name.');
        break;

      case 'ready':
        await ensurePeerConnection();
        if (role === 'offerer') await makeOffer();
        break;

      case 'offer':
        await ensurePeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        applyTier(currentTierIndex); // must run after local description exists
        ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
        break;

      case 'answer':
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        break;

      case 'ice-candidate':
        if (msg.candidate) {
          try { await pc.addIceCandidate(msg.candidate); } catch (e) { /* ignore */ }
        }
        break;

      case 'peer-left':
        setLinkStatus('bad', 'other peer disconnected');
        setBanner('The other person disconnected. Waiting for them to rejoin…');
        break;
    }
  };

  ws.onclose = () => {
    if (manuallyLeft) return;
    setLinkStatus('bad', 'signaling disconnected — retrying…');
    wsReconnectAttempts++;
    const delay = Math.min(1000 * 2 ** wsReconnectAttempts, 15000);
    setTimeout(connectSignaling, delay);
  };

  ws.onerror = () => { /* onclose will fire and handle retry */ };
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------------------------------------------------------------------
// Peer connection setup
// ---------------------------------------------------------------------
async function ensurePeerConnection() {
  if (pc) return;

  pc = new RTCPeerConnection({ iceServers: CONFIG.iceServers });

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: 'ice-candidate', candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    els.remoteVideo.srcObject = e.streams[0];
  };

  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    if (state === 'connected' || state === 'completed') {
      setLinkStatus('good', 'connected');
      setBanner('', false);
      // Fresh warm-up window every time we (re)connect, including after a
      // drop-and-recover — bitrate needs a moment to ramp back up and
      // shouldn't be immediately judged as "still struggling".
      connectionEstablishedAt = Date.now();
      upgradeStreak = 0;
      downgradeStreak = 0;
      smoothedAvailKbps = null;
      // Start from a mid tier on (re)connect rather than the very bottom —
      // avoids a slow crawl back up to HD on a link that's actually fine.
      currentTierIndex = Math.min(currentTierIndex, 1);
      applyTier(currentTierIndex);
    } else if (state === 'disconnected') {
      // Fires a lot on wifi that briefly drops to 0kbps. ICE often
      // recovers on its own within a few seconds — don't panic immediately.
      setLinkStatus('warn', 'link unstable…');
      setTimeout(() => {
        if (pc && pc.iceConnectionState === 'disconnected') attemptIceRestart();
      }, 4000);
    } else if (state === 'failed') {
      setLinkStatus('bad', 'reconnecting…');
      attemptIceRestart();
    } else if (state === 'checking') {
      setLinkStatus('warn', 'connecting…');
    }
  };

  startStatsLoop();
}

async function makeOffer() {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  applyTier(currentTierIndex);
  wsSend({ type: 'offer', sdp: pc.localDescription });
}

async function attemptIceRestart() {
  if (!pc || role !== 'offerer') return; // only the offerer restarts, avoids both sides racing
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    applyTier(currentTierIndex);
    wsSend({ type: 'offer', sdp: pc.localDescription });
  } catch (e) {
    console.warn('ICE restart failed, will retry on next check', e);
  }
}

// ---------------------------------------------------------------------
// Quality tier application — resolution/framerate/bitrate all change via
// setParameters, no camera re-request needed.
// ---------------------------------------------------------------------
function applyTier(tierIndex) {
  if (!pc) return;
  const tier = QUALITY_TIERS[tierIndex];

  pc.getSenders().forEach((sender) => {
    if (!sender.track) return;
    const params = sender.getParameters();
    if (!params.encodings) params.encodings = [{}];

    if (sender.track.kind === 'video') {
      params.encodings[0].maxBitrate = tier.videoBitrateKbps * 1000;
      params.encodings[0].maxFramerate = tier.maxFramerate;
      params.encodings[0].scaleResolutionDownBy = tier.scaleResolutionDownBy;
      params.encodings[0].active = videoEnabled;
    } else if (sender.track.kind === 'audio') {
      params.encodings[0].maxBitrate = CONFIG.audioMaxBitrateKbps * 1000;
    }
    sender.setParameters(params).catch((e) => console.warn('setParameters failed', e));
  });

  els.statTier.textContent = tier.label;
}

// ---------------------------------------------------------------------
// Adaptive stats loop — measures real available bandwidth and picks the
// best quality tier that fits it.
// ---------------------------------------------------------------------
function startStatsLoop() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = setInterval(pollStats, CONFIG.statsIntervalMs);
}

let lastBytesReceivedVideo = 0;
let lastBytesReceivedAudio = 0;
let lastStatsTime = 0;

async function pollStats() {
  if (!pc) return;
  const stats = await pc.getStats();
  let videoKbps = 0, audioKbps = 0, lossPct = 0, rtt = null, jitterMs = null;
  let availableOutgoingKbps = null;
  const now = Date.now();
  const dt = lastStatsTime ? (now - lastStatsTime) / 1000 : null;

  stats.forEach((report) => {
    if (report.type === 'inbound-rtp' && report.kind === 'video') {
      if (dt && lastBytesReceivedVideo) {
        videoKbps = ((report.bytesReceived - lastBytesReceivedVideo) * 8 / 1000) / dt;
      }
      lastBytesReceivedVideo = report.bytesReceived;
      if (report.packetsLost != null && report.packetsReceived) {
        lossPct = (report.packetsLost / (report.packetsLost + report.packetsReceived)) * 100;
      }
      if (report.jitterBufferDelay != null && report.jitterBufferEmittedCount) {
        jitterMs = (report.jitterBufferDelay / report.jitterBufferEmittedCount) * 1000;
      }
    }
    if (report.type === 'inbound-rtp' && report.kind === 'audio') {
      if (dt && lastBytesReceivedAudio) {
        audioKbps = ((report.bytesReceived - lastBytesReceivedAudio) * 8 / 1000) / dt;
      }
      lastBytesReceivedAudio = report.bytesReceived;
    }
    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
      if (report.currentRoundTripTime != null) rtt = report.currentRoundTripTime * 1000;
      // This is WebRTC's own congestion-control estimate of how much
      // bandwidth is available for sending right now — the actual signal
      // we want, since inbound bitrate alone lags behind real capacity.
      if (report.availableOutgoingBitrate != null) {
        availableOutgoingKbps = report.availableOutgoingBitrate / 1000;
      }
    }
  });

  lastStatsTime = now;

  // Smooth the bandwidth estimate (simple EMA) so single noisy samples
  // don't cause tier flapping.
  if (availableOutgoingKbps != null) {
    smoothedAvailKbps = smoothedAvailKbps == null
      ? availableOutgoingKbps
      : smoothedAvailKbps * 0.7 + availableOutgoingKbps * 0.3;
  }

  // --- update UI ---
  els.statVideo.textContent = videoEnabled ? 'on' : 'off (saving bandwidth)';
  els.statAudioKbps.textContent = audioKbps ? `${audioKbps.toFixed(0)} kbps` : '–';
  els.statVideoKbps.textContent = videoKbps ? `${videoKbps.toFixed(0)} kbps` : '–';
  els.statLoss.textContent = `${lossPct.toFixed(1)}%`;
  els.statRtt.textContent = rtt != null ? `${rtt.toFixed(0)} ms` : '–';
  els.statJitter.textContent = jitterMs != null ? `${jitterMs.toFixed(0)} ms` : '–';
  els.statAvailBw.textContent = smoothedAvailKbps != null ? `${smoothedAvailKbps.toFixed(0)} kbps` : '–';

  // If the user manually turned their camera off, that takes priority —
  // don't let the adaptive network logic try to re-enable it underneath them.
  if (userVideoOff) return;

  // During warm-up right after connecting/reconnecting, bandwidth estimates
  // start conservative and ramp up — that's normal, not a bad network.
  const inWarmup = !connectionEstablishedAt || (now - connectionEstablishedAt) < CONFIG.warmupGraceMs;
  if (inWarmup || smoothedAvailKbps == null) return;

  const bottomTier = QUALITY_TIERS[QUALITY_TIERS.length - 1];
  const severelyStruggling = smoothedAvailKbps < bottomTier.minAvailKbps || lossPct > CONFIG.highLossPct * 1.5;

  // --- fully disable video only if even the lowest tier doesn't fit ---
  if (severelyStruggling) {
    disableStreak++;
    recoverStreak = 0;
    if (videoEnabled && disableStreak >= CONFIG.disableVideoStreakNeeded) {
      setVideoEnabled(false);
      setBanner('Network is very slow — video paused to protect audio quality.');
    }
    return;
  } else {
    disableStreak = 0;
    if (!videoEnabled) {
      recoverStreak++;
      if (recoverStreak >= CONFIG.recoverFromDisabledStreakNeeded) {
        setVideoEnabled(true);
        currentTierIndex = QUALITY_TIERS.length - 1; // resume at the lowest tier, then climb
        applyTier(currentTierIndex);
        setBanner('', false);
      }
      return;
    }
  }

  // --- pick the best tier that fits current bandwidth, with hysteresis ---
  const tier = QUALITY_TIERS[currentTierIndex];
  const nextBetterTier = QUALITY_TIERS[currentTierIndex - 1]; // lower index = better

  if (lossPct > CONFIG.highLossPct) {
    // Loss is a stronger, faster signal than throughput — react immediately.
    stepDownTier();
    upgradeStreak = 0;
    downgradeStreak = 0;
    return;
  }

  if (smoothedAvailKbps < tier.minAvailKbps) {
    downgradeStreak++;
    upgradeStreak = 0;
    if (downgradeStreak >= CONFIG.downgradeStreakNeeded) {
      stepDownTier();
      downgradeStreak = 0;
    }
  } else if (nextBetterTier && smoothedAvailKbps > nextBetterTier.minAvailKbps * 1.25) {
    // Require real headroom (25% above the next tier's threshold) before
    // upgrading, so we don't hover right at the edge and flap.
    upgradeStreak++;
    downgradeStreak = 0;
    if (upgradeStreak >= CONFIG.upgradeStreakNeeded) {
      stepUpTier();
      upgradeStreak = 0;
    }
  } else {
    upgradeStreak = 0;
    downgradeStreak = 0;
  }
}

function stepDownTier() {
  if (currentTierIndex < QUALITY_TIERS.length - 1) {
    currentTierIndex++;
    applyTier(currentTierIndex);
    setBanner(`Network slowed down — switched to ${QUALITY_TIERS[currentTierIndex].label} quality.`);
  }
}

function stepUpTier() {
  if (currentTierIndex > 0) {
    currentTierIndex--;
    applyTier(currentTierIndex);
    setBanner('', false);
  }
}

function setVideoEnabled(enabled) {
  videoEnabled = enabled;
  if (!localStream) return;
  localStream.getVideoTracks().forEach((t) => { t.enabled = enabled; });
  if (pc) {
    pc.getSenders().forEach((sender) => {
      if (sender.track && sender.track.kind === 'video') {
        const params = sender.getParameters();
        if (params.encodings && params.encodings[0]) {
          params.encodings[0].active = enabled;
          sender.setParameters(params).catch(() => {});
        }
      }
    });
  }
}

// ---------------------------------------------------------------------
// Manual call controls: mute, camera on/off, fullscreen
// ---------------------------------------------------------------------
function toggleMic() {
  micMuted = !micMuted;
  if (localStream) {
    localStream.getAudioTracks().forEach((t) => { t.enabled = !micMuted; });
  }
  els.micIconOn.style.display = micMuted ? 'none' : '';
  els.micIconOff.style.display = micMuted ? '' : 'none';
  els.micBtn.classList.toggle('off', micMuted);
  els.micBtn.title = micMuted ? 'Unmute microphone' : 'Mute microphone';
}

function toggleCamera() {
  userVideoOff = !userVideoOff;
  els.camIconOn.style.display = userVideoOff ? 'none' : '';
  els.camIconOff.style.display = userVideoOff ? '' : 'none';
  els.camBtn.classList.toggle('off', userVideoOff);
  els.camBtn.title = userVideoOff ? 'Turn on camera' : 'Turn off camera';

  if (userVideoOff) {
    setVideoEnabled(false);
    setBanner('', false);
  } else {
    // Resume at a conservative tier and let the adaptive logic climb back
    // up from there rather than snapping straight to HD.
    currentTierIndex = Math.max(currentTierIndex, QUALITY_TIERS.length - 1);
    setVideoEnabled(true);
    if (pc) applyTier(currentTierIndex);
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    els.callStage.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
}

document.addEventListener('fullscreenchange', () => {
  const isFs = !!document.fullscreenElement;
  els.callStage.classList.toggle('is-fullscreen', isFs);
  els.fsIconEnter.style.display = isFs ? 'none' : '';
  els.fsIconExit.style.display = isFs ? '' : 'none';
  els.fullscreenBtn.title = isFs ? 'Exit full screen' : 'Full screen';
});

function setInCallControlsEnabled(enabled) {
  els.micBtn.disabled = !enabled;
  els.camBtn.disabled = !enabled;
  els.fullscreenBtn.disabled = !enabled;
  els.leaveBtn.disabled = !enabled;
}

function resetControlsUI() {
  micMuted = false;
  userVideoOff = false;
  els.micIconOn.style.display = '';
  els.micIconOff.style.display = 'none';
  els.micBtn.classList.remove('off');
  els.camIconOn.style.display = '';
  els.camIconOff.style.display = 'none';
  els.camBtn.classList.remove('off');
  if (document.fullscreenElement) document.exitFullscreen?.();
}

els.micBtn.addEventListener('click', toggleMic);
els.camBtn.addEventListener('click', toggleCamera);
els.fullscreenBtn.addEventListener('click', toggleFullscreen);

// ---------------------------------------------------------------------
// Media capture
// ---------------------------------------------------------------------
async function getLocalMedia() {
  const constraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1, // mono — halves audio bandwidth vs stereo, inaudible difference on calls
    },
    video: {
      width: { ideal: CAPTURE.width },
      height: { ideal: CAPTURE.height },
      frameRate: { ideal: CAPTURE.fps, max: CAPTURE.fps },
    },
  };
  localStream = await navigator.mediaDevices.getUserMedia(constraints);
  els.localVideo.srcObject = localStream;
}

// ---------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------
els.joinBtn.addEventListener('click', async () => {
  room = els.roomId.value.trim();
  if (!room) { setBanner('Enter a room name first.'); return; }

  try {
    await getLocalMedia();
  } catch (e) {
    setBanner('Could not access camera/mic: ' + e.message);
    return;
  }

  manuallyLeft = false;
  els.joinBtn.disabled = true;
  setInCallControlsEnabled(true);
  setLinkStatus('warn', 'connecting to signaling server…');
  connectSignaling();
});

els.leaveBtn.addEventListener('click', () => {
  manuallyLeft = true;
  if (statsTimer) clearInterval(statsTimer);
  if (pc) { pc.close(); pc = null; }
  if (ws) { ws.close(); ws = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  els.localVideo.srcObject = null;
  els.remoteVideo.srcObject = null;
  els.joinBtn.disabled = false;
  els.leaveBtn.disabled = true;
  setInCallControlsEnabled(false);
  resetControlsUI();
  currentTierIndex = 0;
  connectionEstablishedAt = null;
  smoothedAvailKbps = null;
  setLinkStatus('idle', 'not connected');
  setBanner('', false);
});

iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: 'turn:free.expressturn.com:3478',   // <-- Added 'turn:' prefix here
    username: '000000002098864023',
    credential: 'NzC5d9rM4ZACkoQQgq/dGEXclr0=',
  },
]