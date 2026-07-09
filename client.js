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
  roomId: $('roomId'),
  joinBtn: $('joinBtn'),
  leaveBtn: $('leaveBtn'),
  permBtn: $('permBtn'),
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
  pipBtn: $('pipBtn'),
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
  // Your deployed signaling server (Render). Update this if you redeploy
  // to a different host.
  signalingUrl: 'wss://vcall-5ngo.onrender.com',

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
    {
      urls: 'turn:free.expressturn.com:3478',
      username: '000000002098864023',
      credential: 'NzC5d9rM4ZACkoQQgq/dGEXclr0=',
    },
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
let mediaReady = false;   // true once camera/mic permission has been granted

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
  const url = CONFIG.signalingUrl;
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

// ---------------------------------------------------------------------
// Picture-in-Picture: keeps the other person visible in a floating window
// when the app is minimized or you switch tabs/apps mid-call.
//
// Two mechanisms layered together:
//   1. `autopictureinpicture` attribute on the video element (set in HTML)
//      — Chrome/Edge on Android and desktop handle this automatically the
//      moment the tab/app is backgrounded. No JS needed for this path.
//   2. A manual fallback here for browsers that need an explicit request
//      (and Safari, which uses its own webkitSetPresentationMode API
//      instead of the standard Picture-in-Picture API).
// ---------------------------------------------------------------------
function pipIsSupported() {
  return document.pictureInPictureEnabled
    || (els.remoteVideo.webkitSupportsPresentationMode
        && typeof els.remoteVideo.webkitSetPresentationMode === 'function');
}

async function togglePiP() {
  try {
    if (els.remoteVideo.webkitSupportsPresentationMode
        && typeof els.remoteVideo.webkitSetPresentationMode === 'function') {
      // Safari (iOS/macOS) path
      const inPip = els.remoteVideo.webkitPresentationMode === 'picture-in-picture';
      els.remoteVideo.webkitSetPresentationMode(inPip ? 'inline' : 'picture-in-picture');
      return;
    }
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled && els.remoteVideo.srcObject) {
      await els.remoteVideo.requestPictureInPicture();
    }
  } catch (e) {
    console.warn('Picture-in-Picture failed', e);
  }
}

function setPipButtonState(active) {
  els.pipBtn.classList.toggle('off', active);
  els.pipBtn.title = active ? 'Exit picture-in-picture' : 'Picture-in-picture';
}

els.remoteVideo.addEventListener('enterpictureinpicture', () => setPipButtonState(true));
els.remoteVideo.addEventListener('leavepictureinpicture', () => setPipButtonState(false));
els.remoteVideo.addEventListener('webkitpresentationmodechanged', () => {
  setPipButtonState(els.remoteVideo.webkitPresentationMode === 'picture-in-picture');
});

// Fallback for browsers that don't auto-PiP via the HTML attribute alone:
// try to enter PiP the moment the app is backgrounded mid-call, and leave
// it when you come back. This is best-effort — some browsers only allow
// requestPictureInPicture() from a direct user gesture and will silently
// reject it here, which is fine, since the `autopictureinpicture`
// attribute already covers those browsers natively.
document.addEventListener('visibilitychange', () => {
  if (!pc || !els.remoteVideo.srcObject) return; // not in an active call

  if (document.hidden) {
    if (document.pictureInPictureEnabled && !document.pictureInPictureElement) {
      els.remoteVideo.requestPictureInPicture().catch(() => {});
    }
  } else {
    if (document.pictureInPictureElement === els.remoteVideo) {
      document.exitPictureInPicture().catch(() => {});
    }
  }
});

els.pipBtn.addEventListener('click', togglePiP);
if (!pipIsSupported()) {
  els.pipBtn.style.display = 'none';
}

function setInCallControlsEnabled(enabled) {
  els.micBtn.disabled = !enabled;
  els.camBtn.disabled = !enabled;
  els.fullscreenBtn.disabled = !enabled;
  els.pipBtn.disabled = !enabled;
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

// Some browsers (particularly iOS Safari, and Chrome in certain embedded
// webviews) don't reliably show the permission prompt automatically, or
// silently fail if the request isn't tied directly to a user tap. This
// gives people an explicit, unambiguous button to trigger it — and shows
// a live camera preview immediately as confirmation it worked, before
// they've even entered a room name.
async function requestPermissions() {
  if (mediaReady) return true;
  els.permBtn.disabled = true;
  els.permBtn.textContent = 'Requesting…';
  setBanner('', false);

  try {
    await getLocalMedia();
    mediaReady = true;
    els.permBtn.textContent = 'Camera & mic ready ✓';
    els.permBtn.classList.add('secondary');
    return true;
  } catch (e) {
    els.permBtn.disabled = false;
    els.permBtn.textContent = 'Allow camera & microphone';

    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      setBanner('Camera/mic access is blocked. Open your browser\'s site settings for this page, allow Camera and Microphone, then click the button again.');
    } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
      setBanner('No camera or microphone was found on this device.');
    } else if (e.name === 'NotReadableError') {
      setBanner('Camera/mic is already in use by another app. Close it and try again.');
    } else {
      setBanner('Could not access camera/mic: ' + e.message);
    }
    return false;
  }
}

els.permBtn.addEventListener('click', requestPermissions);

// ---------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------
els.joinBtn.addEventListener('click', async () => {
  room = els.roomId.value.trim();
  if (!room) { setBanner('Enter a room name first.'); return; }

  if (!mediaReady) {
    const ok = await requestPermissions();
    if (!ok) return;
  }

  manuallyLeft = false;
  els.joinBtn.disabled = true;
  setInCallControlsEnabled(true);
  setLinkStatus('warn', 'connecting to signaling server…');
  connectSignaling();
});

els.leaveBtn.addEventListener('click', () => {
  manuallyLeft = true;
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
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
  mediaReady = false;
  els.permBtn.disabled = false;
  els.permBtn.textContent = 'Allow camera & microphone';
  els.permBtn.classList.remove('secondary');
  currentTierIndex = 0;
  connectionEstablishedAt = null;
  smoothedAvailKbps = null;
  setLinkStatus('idle', 'not connected');
  setBanner('', false);
});