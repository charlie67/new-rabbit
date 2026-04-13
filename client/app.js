// --- DOM elements ---
const video = document.getElementById('viewport');
const overlay = document.getElementById('input-overlay');
const urlInput = document.getElementById('url-input');
const goBtn = document.getElementById('go-btn');
const backBtn = document.getElementById('back-btn');
const forwardBtn = document.getElementById('forward-btn');
const connectionStatus = document.getElementById('connection-status');
const userList = document.getElementById('user-list');
const nicknameInput = document.getElementById('nickname-input');
const nicknameBtn = document.getElementById('nickname-btn');
const controlBtn = document.getElementById('control-btn');
const controllerStatus = document.getElementById('controller-status');
const audioBtn = document.getElementById('audio-btn');

// --- State ---
let ws = null;
let myId = null;
let isController = false;
let users = [];
let player = null;

// --- Audio unmute ---
audioBtn.addEventListener('click', () => {
  if (video.muted) {
    video.muted = false;
    audioBtn.textContent = 'Mute';
    audioBtn.classList.remove('muted');
    audioBtn.classList.add('unmuted');
    video.play().catch(() => {});
  } else {
    video.muted = true;
    audioBtn.textContent = 'Unmute';
    audioBtn.classList.remove('unmuted');
    audioBtn.classList.add('muted');
  }
});

// --- URL display helper ---
function handleUrlInput(inputUrl) {
  if (inputUrl === 'about:blank' || inputUrl.startsWith('data:text')) {
    return 'Enter a URL...';
  }
  return inputUrl;
}

// --- WebSocket ---
function connect() {
  initPlayer();

  ws = new WebSocket(`ws://${window.location.host}`);

  ws.onopen = () => {
    connectionStatus.textContent = 'Connected';
    connectionStatus.className = 'connected';
  };

  ws.onclose = () => {
    connectionStatus.textContent = 'Disconnected';
    connectionStatus.className = 'disconnected';
    myId = null;
    isController = false;
    if (player) {
      clearInterval(player._liveSeekTimer);
      player.destroy();
      player = null;
    }
    updateControlUI();
    setTimeout(connect, 2000);
  };

  ws.onerror = () => {};

  ws.onmessage = (event) => {

    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'welcome':
        myId = msg.clientId;
        urlInput.value = handleUrlInput(msg.currentUrl);
        updateUsers(msg.users);
        if (msg.controllerId === myId) {
          setControl(true);
        }
        break;

      case 'userList':
        updateUsers(msg.users);
        break;

      case 'controlGranted':
        if (msg.clientId === myId) {
          setControl(true);
        }
        updateControllerLabel();
        break;

      case 'controlReleased':
        if (msg.clientId === myId) {
          setControl(false);
        }
        updateControllerLabel();
        break;

      case 'navResult':
        if (msg.success && msg.url) {
          urlInput.value = handleUrlInput(msg.url);
        }
        break;

      case 'urlChanged':
        urlInput.value = handleUrlInput(msg.url);
        break;

      case 'error':
        showError(msg.message);
        break;
    }
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// --- Media player ---
function initPlayer() {
  if (player) {
    clearInterval(player._liveSeekTimer);
    player.destroy();
    player = null;
  }

  if (!mpegts.isSupported()) {
    console.error('mpegts.js is not supported in this browser');
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  player = mpegts.createPlayer({
    type: 'mpegts',
    isLive: true,
    url: `${protocol}//${window.location.host}/media`,
  }, {
    enableWorker: true,
    liveBufferLatencyChasing: true,
    liveBufferLatencyMaxLatency: 0.4,
    liveBufferLatencyMinRemain: 0.1,
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: 5,
    autoCleanupMinBackwardDuration: 3,
  });

  player.attachMediaElement(video);
  player.load();

  video.play().catch(() => {});

  // Seek to live edge whenever buffer accumulates
  player._liveSeekTimer = setInterval(() => {
    if (!video.buffered.length) return;
    const end = video.buffered.end(video.buffered.length - 1);
    const latency = end - video.currentTime;
    let dbg = document.getElementById('latency-dbg');
    if (!dbg) {
      dbg = document.createElement('div');
      dbg.id = 'latency-dbg';
      dbg.style.cssText = 'position:fixed;top:4px;right:4px;background:rgba(0,0,0,.7);color:#0f0;font:bold 14px monospace;padding:4px 8px;z-index:9999;pointer-events:none';
      document.body.appendChild(dbg);
    }
    dbg.textContent = `buf: ${latency.toFixed(2)}s | ${video.paused ? 'PAUSED' : 'playing'}`;
    if (latency > 0.5) {
      video.currentTime = end - 0.1;
    }
  }, 500);

  player.on(mpegts.Events.ERROR, () => {
    setTimeout(() => {
      if (player) {
        player.destroy();
        initPlayer();
      }
    }, 2000);
  });
}

// --- UI updates ---
function updateUsers(list) {
  users = list;
  userList.innerHTML = '';
  for (const u of users) {
    const li = document.createElement('li');
    let label = u.nickname;
    if (u.isController) label += ' *';
    if (u.id === myId) label += ' (you)';
    li.textContent = label;
    if (u.isController) li.classList.add('controller');
    if (u.id === myId) li.classList.add('self');
    userList.appendChild(li);
  }
  updateControllerLabel();
}

function updateControllerLabel() {
  const controller = users.find((u) => u.isController);
  if (controller) {
    const name = controller.id === myId ? 'You' : controller.nickname;
    controllerStatus.textContent = `${name} ha${controller.id === myId ? 've' : 's'} control`;
  } else {
    controllerStatus.textContent = 'No one has control';
  }
}

function setControl(hasControl) {
  isController = hasControl;
  updateControlUI();
  if (hasControl) {
    overlay.focus();
  }
}

function updateControlUI() {
  if (isController) {
    controlBtn.textContent = 'Release Control';
    controlBtn.className = 'release';
  } else {
    controlBtn.textContent = 'Take Control';
    controlBtn.className = 'take';
  }
}

function showError(message) {
  console.warn('Server error:', message);
  const prev = controllerStatus.textContent;
  controllerStatus.textContent = message;
  controllerStatus.style.color = '#e94560';
  setTimeout(() => {
    controllerStatus.textContent = prev;
    controllerStatus.style.color = '';
  }, 3000);
}

// --- URL navigation ---
function navigateToUrl() {
  const url = urlInput.value.trim();
  if (url) {
    send({ type: 'navigate', url });
  }
}

goBtn.addEventListener('click', navigateToUrl);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigateToUrl();
});

backBtn.addEventListener('click', () => send({ type: 'navBack' }));
forwardBtn.addEventListener('click', () => send({ type: 'navForward' }));

// --- Nickname ---
nicknameBtn.addEventListener('click', () => {
  const name = nicknameInput.value.trim();
  if (name) {
    send({ type: 'setNickname', nickname: name });
    nicknameInput.value = '';
  }
});
nicknameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') nicknameBtn.click();
});

// --- Control button ---
controlBtn.addEventListener('click', () => {
  if (isController) {
    send({ type: 'releaseControl' });
  } else {
    send({ type: 'requestControl' });
  }
});

// --- Input capture (on the overlay div, positioned over the video) ---
const BUTTON_MAP = { 0: 'left', 1: 'middle', 2: 'right' };
const MOUSE_MOVE_INTERVAL = 33; // ~30fps
let lastMouseMove = 0;

function getVideoCoords(e) {
  const rect = overlay.getBoundingClientRect();
  const videoRatio = 1920 / 1080;
  const containerRatio = rect.width / rect.height;

  let renderWidth, renderHeight, offsetX, offsetY;
  if (containerRatio > videoRatio) {
    renderHeight = rect.height;
    renderWidth = rect.height * videoRatio;
    offsetX = (rect.width - renderWidth) / 2;
    offsetY = 0;
  } else {
    renderWidth = rect.width;
    renderHeight = rect.width / videoRatio;
    offsetX = 0;
    offsetY = (rect.height - renderHeight) / 2;
  }

  return {
    x: ((e.clientX - rect.left - offsetX) / renderWidth) * 1920,
    y: ((e.clientY - rect.top - offsetY) / renderHeight) * 1080,
  };
}

function getModifiers(e) {
  let m = 0;
  if (e.altKey) m |= 1;
  if (e.ctrlKey) m |= 2;
  if (e.metaKey) m |= 4;
  if (e.shiftKey) m |= 8;
  return m;
}

overlay.addEventListener('mousedown', (e) => {
  if (!isController) return;
  e.preventDefault();
  overlay.focus();
  const { x, y } = getVideoCoords(e);
  send({
    type: 'mouseEvent', subType: 'mousedown', x, y,
    button: BUTTON_MAP[e.button] || 'left',
    clickCount: e.detail,
    modifiers: getModifiers(e),
  });
});

overlay.addEventListener('mouseup', (e) => {
  if (!isController) return;
  e.preventDefault();
  const { x, y } = getVideoCoords(e);
  send({
    type: 'mouseEvent', subType: 'mouseup', x, y,
    button: BUTTON_MAP[e.button] || 'left',
    clickCount: e.detail,
    modifiers: getModifiers(e),
  });
});

overlay.addEventListener('mousemove', (e) => {
  if (!isController) return;
  const now = Date.now();
  if (now - lastMouseMove < MOUSE_MOVE_INTERVAL) return;
  lastMouseMove = now;
  const { x, y } = getVideoCoords(e);
  send({
    type: 'mouseEvent', subType: 'mousemove', x, y,
    modifiers: getModifiers(e),
  });
});

overlay.addEventListener('wheel', (e) => {
  if (!isController) return;
  e.preventDefault();
  const { x, y } = getVideoCoords(e);
  send({
    type: 'wheelEvent', x, y,
    deltaX: e.deltaX, deltaY: e.deltaY,
    modifiers: getModifiers(e),
  });
}, { passive: false });

overlay.addEventListener('contextmenu', (e) => e.preventDefault());

overlay.addEventListener('keydown', (e) => {
  if (!isController) return;
  e.preventDefault();
  send({
    type: 'keyEvent', subType: 'keydown',
    key: e.key, code: e.code,
    modifiers: getModifiers(e),
  });
});

overlay.addEventListener('keyup', (e) => {
  if (!isController) return;
  e.preventDefault();
  send({
    type: 'keyEvent', subType: 'keyup',
    key: e.key, code: e.code,
    modifiers: getModifiers(e),
  });
});

// --- Start ---
connect();
