(() => {
  'use strict';

  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const overlay = document.getElementById('game-overlay');
  const overlayKicker = document.getElementById('overlay-kicker-text');
  const overlayTitle = document.getElementById('overlay-title');
  const overlayCopy = document.getElementById('overlay-copy');
  const launchButton = document.getElementById('start-run');
  const roomCodeEl = document.getElementById('room-code');
  const serverAddressEl = document.getElementById('server-address');
  const serverAddressNoteEl = document.getElementById('server-address-note');
  const linkStatus = document.getElementById('link-status');
  const linkStatusText = document.getElementById('link-status-text');
  const pilotCard = document.getElementById('pilot-card');
  const pilotConnection = document.getElementById('pilot-connection');
  const pilotCopy = document.getElementById('pilot-copy');
  const stageState = document.getElementById('stage-state');
  const playfieldStatus = document.getElementById('playfield-status');
  const scoreEl = document.getElementById('score-value');
  const waveEl = document.getElementById('wave-value');
  const hullEl = document.getElementById('hull-value');
  const railSpeedEl = document.getElementById('rail-speed-value');
  const copyButton = document.getElementById('copy-link');
  const copyLabel = document.getElementById('copy-label');
  const copyNote = document.getElementById('copy-note');

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const random = (min, max) => min + Math.random() * (max - min);
  let width = 1;
  let height = 1;
  let dpr = 1;
  let roomCode = '';
  let androidServerAddress = window.location.origin;
  let peer = null;
  let reconnectTimer = null;
  let controllerConnected = false;
  let gameMode = 'ready';
  let score = 0;
  let hull = 3;
  let wave = 1;
  let playerX = 0.5;
  let inputX = 0;
  let inputThrottle = 0;
  let railSpeed = 1;
  let railPhase = 0;
  let keyboardX = 0;
  let shootTimer = 0;
  let spawnTimer = 0.6;
  let elapsed = 0;
  let invulnerable = 0;
  let hitFlash = 0;
  let lastFrame = performance.now();
  let stars = [];
  let enemies = [];
  let bullets = [];
  let particles = [];
  let copyTimeout = null;
  const keys = new Set();

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!stars.length) {
      stars = Array.from({ length: Math.round(clamp(width * height / 4200, 75, 180)) }, () => ({
        x: Math.random(), y: Math.random(), z: random(.15, 1), phase: random(0, 6.28)
      }));
    }
  }
  window.addEventListener('resize', resize, { passive: true });
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
  resize();

  function setLinkStatus(mode) {
    linkStatus.classList.remove('is-connected', 'is-disconnected');
    if (mode === 'connected') {
      linkStatus.classList.add('is-connected');
      linkStatusText.textContent = 'PILOT CONNECTED';
    } else if (mode === 'reconnecting') {
      linkStatus.classList.add('is-disconnected');
      linkStatusText.textContent = 'RECONNECTING';
    } else if (mode === 'offline') {
      linkStatus.classList.add('is-disconnected');
      linkStatusText.textContent = 'LINK OFFLINE';
    } else {
      linkStatusText.textContent = 'WAITING FOR PILOT';
    }
  }

  function sendGameEvent(payload) {
    if (peer && peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(payload));
  }

  function setRoomCode(code) {
    roomCode = String(code || '').toUpperCase();
    if (serverAddressEl) serverAddressEl.textContent = androidServerAddress;
    if (roomCode) {
      roomCodeEl.textContent = roomCode;
      roomCodeEl.setAttribute('aria-label', `Room code ${roomCode}`);
      try { localStorage.setItem('starlane-room', roomCode); } catch { /* Private browsing can disable storage. */ }
    }
  }

  async function resolveAndroidServerAddress() {
    const localHost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname.toLowerCase());
    androidServerAddress = window.location.origin;
    if (localHost) {
      try {
        const response = await fetch('/api/info', { cache: 'no-store' });
        const info = await response.json();
        const lanAddress = Array.isArray(info.lanAddresses) ? info.lanAddresses[0] : '';
        if (lanAddress) {
          const port = info.port || window.location.port || 3000;
          androidServerAddress = `http://${lanAddress}:${port}`;
          if (serverAddressNoteEl) serverAddressNoteEl.textContent = 'LAN address for the Android app. Keep the laptop and phone on the same Wi-Fi.';
        } else if (serverAddressNoteEl) {
          serverAddressNoteEl.textContent = 'This page uses localhost. Enter the laptop Wi-Fi IP in Android; localhost on the phone points to the phone.';
        }
      } catch {
        if (serverAddressNoteEl) serverAddressNoteEl.textContent = 'If this says localhost, use the laptop Wi-Fi IP in Android—not localhost.';
      }
    } else if (serverAddressNoteEl) {
      serverAddressNoteEl.textContent = 'Use this exact address in the Android app. Keep this game server running.';
    }
    if (serverAddressEl) serverAddressEl.textContent = androidServerAddress;
  }

  function updatePilotUI() {
    if (controllerConnected) {
      pilotCard.classList.add('is-connected');
      pilotConnection.textContent = 'PILOT LINKED';
      pilotCopy.textContent = 'Phone controls live. Roll to steer; pitch to set rail speed.';
      setLinkStatus('connected');
    } else {
      pilotCard.classList.remove('is-connected');
      pilotConnection.textContent = 'WAITING FOR PILOT';
      pilotCopy.textContent = 'Pair a phone to take the controls.';
      setLinkStatus(peer && peer.readyState === WebSocket.OPEN ? 'waiting' : 'reconnecting');
    }
  }

  function connectGameSocket() {
    clearTimeout(reconnectTimer);
    if (!('WebSocket' in window)) {
      setLinkStatus('offline');
      pilotCopy.textContent = 'This browser does not support WebSockets.';
      return;
    }
    const params = new URLSearchParams({ role: 'game' });
    try {
      const saved = localStorage.getItem('starlane-room');
      if (saved) params.set('room', saved);
    } catch { /* Keep working without persistent room storage. */ }
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${window.location.host}/ws?${params.toString()}`);
    peer = socket;
    setLinkStatus('reconnecting');
    socket.addEventListener('open', () => {
      if (peer !== socket) return;
      setLinkStatus('waiting');
    });
    socket.addEventListener('message', (event) => {
      if (peer !== socket) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'room') setRoomCode(message.code);
      if (message.type === 'controller') {
        controllerConnected = Boolean(message.connected);
        if (!controllerConnected) {
          inputX = 0;
          inputThrottle = 0;
        }
        updatePilotUI();
      }
      if (message.type === 'input') {
        inputX = clamp(Number(message.x) || 0, -1, 1);
        inputThrottle = clamp(Number(message.throttle) || 0, -1, 1);
      }
      if (message.type === 'error') {
        pilotCopy.textContent = message.message || 'Could not connect to the flight deck.';
      }
    });
    socket.addEventListener('close', () => {
      if (peer !== socket) return;
      peer = null;
      controllerConnected = false;
      inputX = 0;
      inputThrottle = 0;
      updatePilotUI();
      setLinkStatus('reconnecting');
      reconnectTimer = setTimeout(connectGameSocket, 1400);
    });
    socket.addEventListener('error', () => {
      if (peer === socket) setLinkStatus('offline');
    });
  }

  resolveAndroidServerAddress();
  connectGameSocket();

  function updateHUD() {
    scoreEl.textContent = String(score).padStart(6, '0');
    waveEl.textContent = String(wave).padStart(2, '0');
    hullEl.textContent = Array.from({ length: 3 }, (_, index) => index < hull ? '●' : '○').join(' ');
    hullEl.style.color = hull <= 1 ? '#ff7b82' : '#b6ffce';
  }

  function startRun() {
    score = 0;
    hull = 3;
    wave = 1;
    playerX = 0.5;
    inputX = 0;
    inputThrottle = 0;
    railSpeed = 1;
    railPhase = 0;
    shootTimer = 0;
    spawnTimer = .45;
    elapsed = 0;
    invulnerable = 0;
    hitFlash = 0;
    enemies = [];
    bullets = [];
    particles = [];
    gameMode = 'playing';
    overlay.classList.add('is-hidden');
    stageState.textContent = 'FLIGHT ACTIVE';
    playfieldStatus.textContent = 'IN FLIGHT';
    updateHUD();
  }

  function endRun() {
    gameMode = 'gameover';
    stageState.textContent = 'MISSION ENDED';
    playfieldStatus.textContent = 'FLIGHT ENDED';
    overlayKicker.textContent = 'FLIGHT LOG // COMPLETE';
    overlayTitle.innerHTML = 'RUN<br><em>COMPLETE.</em>';
    overlayCopy.innerHTML = `FINAL SCORE <b>${String(score).padStart(6, '0')}</b><br>Ready to take another pass?`;
    launchButton.querySelector('span:first-child').textContent = 'FLY AGAIN';
    overlay.classList.remove('is-hidden');
  }

  launchButton.addEventListener('click', startRun);
  updateHUD();

  function updatePlayerTarget() {
    const left = keys.has('ArrowLeft') || keys.has('a') || keys.has('A');
    const right = keys.has('ArrowRight') || keys.has('d') || keys.has('D');
    if (left || right) keyboardX = (right ? 1 : 0) - (left ? 1 : 0);
    else keyboardX = 0;
    const desired = (left || right) ? .5 + keyboardX * .42 : .5 + inputX * .44;
    playerX += (clamp(desired, .055, .945) - playerX) * Math.min(1, 9 * frameDelta);
  }

  window.addEventListener('keydown', (event) => {
    const key = event.key;
    if (['ArrowLeft', 'ArrowRight', ' ', 'Spacebar'].includes(key)) event.preventDefault();
    keys.add(key);
    if ((key === 'Enter' || key === ' ') && (gameMode === 'ready' || gameMode === 'gameover')) startRun();
  });
  window.addEventListener('keyup', (event) => {
    keys.delete(event.key);
  });
  window.addEventListener('blur', () => { keys.clear(); });

  copyButton.addEventListener('click', async () => {
    const address = androidServerAddress || window.location.origin;
    try {
      await navigator.clipboard.writeText(address);
      copyLabel.textContent = 'SERVER URL COPIED';
      copyNote.textContent = `Paste into the Android app · room ${roomCode || '— — — — — —'}`;
    } catch {
      copyNote.textContent = address;
      copyLabel.textContent = 'ANDROID SERVER URL';
    }
    clearTimeout(copyTimeout);
    copyTimeout = setTimeout(() => { copyLabel.textContent = 'COPY ANDROID SERVER URL'; copyNote.textContent = ''; }, 3200);
  });

  function spawnEnemy() {
    const lane = Math.random();
    enemies.push({
      x: .11 + lane * .78,
      depth: 0,
      speed: .24 + Math.min(wave - 1, 9) * .019 + random(-.025, .035),
      size: random(.85, 1.2),
      phase: random(0, Math.PI * 2),
      type: Math.random() < .68 ? 'rock' : 'drone',
      dead: false
    });
  }

  function fireShot() {
    const x = playerX;
    const y = height * .755;
    bullets.push({ x, y, vy: -height * 1.12, trail: random(14, 24), dead: false });
    particles.push({ x: x * width, y: y + 5, vx: random(-18, 18), vy: random(-80, -20), life: .17, max: .17, size: random(1, 2.3), color: '#c4ffff' });
  }

  function explode(x, y, color = '#ffce91') {
    for (let i = 0; i < 12; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = random(35, 170);
      particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: random(.25, .6), max: .6, size: random(1.2, 3), color });
    }
  }

  function damageShip() {
    if (invulnerable > 0 || gameMode !== 'playing') return;
    hull -= 1;
    invulnerable = 1.25;
    hitFlash = .3;
    sendGameEvent({ type: 'hit', target: 'player' });
    explode(playerX * width, height * .78, '#ff7182');
    updateHUD();
    if (hull <= 0) endRun();
  }

  function update(dt) {
    elapsed += dt;
    frameDelta = dt;
    const targetRailSpeed = gameMode === 'playing' ? clamp(1 + inputThrottle * .8, .45, 1.8) : 1;
    railSpeed += (targetRailSpeed - railSpeed) * Math.min(1, dt * 3.4);
    railPhase = (railPhase + dt * railSpeed * (gameMode === 'playing' ? .52 : .12)) % 1;
    if (railSpeedEl) railSpeedEl.textContent = `${railSpeed.toFixed(1)}×`;
    if (gameMode === 'playing') {
      updatePlayerTarget();
      if (invulnerable > 0) invulnerable -= dt;
      if (hitFlash > 0) hitFlash -= dt;

      // The interceptor fires continuously throughout the run.
      shootTimer -= dt;
      if (shootTimer <= 0) {
        fireShot();
        shootTimer = .18;
      }

      spawnTimer -= dt * railSpeed;
      if (spawnTimer <= 0) {
        spawnEnemy();
        const base = Math.max(.48, .95 - Math.min(wave - 1, 10) * .035);
        spawnTimer = base * random(.72, 1.24);
      }

      const horizon = height * .24;
      const travel = height * .64;
      for (const enemy of enemies) {
        enemy.depth += enemy.speed * dt * railSpeed;
        enemy.x += Math.sin(elapsed * 1.15 + enemy.phase) * .004 * dt;
        const enemyY = horizon + enemy.depth * travel;
        const enemyRadius = (9 + enemy.depth * 19) * enemy.size;
        for (const bullet of bullets) {
          if (bullet.dead) continue;
          const bx = bullet.x * width;
          if (Math.abs(bx - enemy.x * width) < enemyRadius * .85 && Math.abs(bullet.y - enemyY) < enemyRadius + 8) {
            bullet.dead = true;
            enemy.dead = true;
            if (enemy.type === 'rock') sendGameEvent({ type: 'hit', target: 'asteroid' });
            score += enemy.type === 'drone' ? 150 : 100;
            wave = Math.min(99, Math.floor(score / 600) + 1);
            explode(enemy.x * width, enemyY, enemy.type === 'drone' ? '#87e7ff' : '#ffc777');
            updateHUD();
            break;
          }
        }
        if (!enemy.dead && enemy.depth > .82 && Math.abs(enemy.x - playerX) < .04 + enemy.depth * .014) {
          enemy.dead = true;
          damageShip();
        }
        if (enemy.depth > 1.12) enemy.dead = true;
      }
      enemies = enemies.filter((enemy) => !enemy.dead);
      for (const bullet of bullets) {
        bullet.y += bullet.vy * dt;
        if (bullet.y < height * .17) bullet.dead = true;
      }
      bullets = bullets.filter((bullet) => !bullet.dead);
    } else {
      if (hitFlash > 0) hitFlash -= dt;
      playerX += (.5 - playerX) * Math.min(1, 1.5 * dt);
    }

    for (const star of stars) {
      star.y += (0.008 + star.z * .065) * dt * (gameMode === 'playing' ? 1.8 * railSpeed : .6);
      star.phase += dt * (1 + star.z * 3);
      if (star.y > 1.02) {
        star.y = -.02;
        star.x = Math.random();
        star.z = random(.15, 1);
      }
    }
    for (const particle of particles) {
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vx *= Math.max(0, 1 - dt * 1.4);
      particle.vy *= Math.max(0, 1 - dt * .7);
      particle.life -= dt;
    }
    particles = particles.filter((particle) => particle.life > 0);
  }

  let frameDelta = 0;
  function drawBackground() {
    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, '#07111f');
    bg.addColorStop(.42, '#0a1930');
    bg.addColorStop(1, '#07101d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    const nebula = ctx.createRadialGradient(width * .53, height * .35, 0, width * .53, height * .35, width * .56);
    nebula.addColorStop(0, 'rgba(30, 105, 131, .19)');
    nebula.addColorStop(.48, 'rgba(34, 64, 109, .11)');
    nebula.addColorStop(1, 'rgba(7, 13, 26, 0)');
    ctx.fillStyle = nebula;
    ctx.fillRect(0, 0, width, height);

    for (const star of stars) {
      const x = star.x * width;
      const y = star.y * height;
      const tw = .45 + Math.sin(star.phase) * .25;
      const radius = .45 + star.z * 1.1;
      ctx.fillStyle = `rgba(${star.z > .78 ? '168, 242, 255' : '201, 221, 244'}, ${clamp(tw * (.32 + star.z * .5), .12, .85)})`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      if (star.z > .9) {
        ctx.globalAlpha = .2;
        ctx.fillRect(x - .4, y - 4, .8, 8);
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawRails() {
    const horizon = height * .24;
    const center = width * .5;
    const bottom = height;
    const road = ctx.createLinearGradient(0, horizon, 0, bottom);
    road.addColorStop(0, 'rgba(27, 70, 99, .06)');
    road.addColorStop(.34, 'rgba(17, 47, 73, .24)');
    road.addColorStop(1, 'rgba(9, 28, 48, .52)');
    ctx.fillStyle = road;
    ctx.beginPath();
    ctx.moveTo(center - width * .075, horizon);
    ctx.lineTo(center + width * .075, horizon);
    ctx.lineTo(width * .92, bottom);
    ctx.lineTo(width * .08, bottom);
    ctx.closePath();
    ctx.fill();

    ctx.save();
    ctx.lineWidth = 1;
    for (let i = -7; i <= 7; i++) {
      const endX = center + i * width * .085;
      const startX = center + i * width * .015;
      const alpha = i % 2 === 0 ? .19 : .09;
      ctx.strokeStyle = `rgba(101, 206, 226, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(startX, horizon);
      ctx.lineTo(endX, bottom);
      ctx.stroke();
    }
    for (let i = 0; i <= 11; i++) {
      const p = (i / 11 + railPhase) % 1;
      const y = horizon + (bottom - horizon) * p * p;
      const alpha = .04 + p * .095;
      ctx.strokeStyle = `rgba(96, 182, 205, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(center - width * (.075 + .39 * p), y);
      ctx.lineTo(center + width * (.075 + .39 * p), y);
      ctx.stroke();
    }
    ctx.restore();

    // The three glowing rails are the visual anchor for the on-rails flight path.
    const railPairs = [
      { x0: .442, x1: .255, a: .32 },
      { x0: .558, x1: .745, a: .32 },
      { x0: .474, x1: .395, a: .16 },
      { x0: .526, x1: .605, a: .16 }
    ];
    for (const rail of railPairs) {
      ctx.save();
      ctx.strokeStyle = `rgba(79, 221, 232, ${rail.a})`;
      ctx.shadowColor = 'rgba(67, 219, 238, .48)';
      ctx.shadowBlur = 8;
      ctx.lineWidth = rail.a > .2 ? 1.7 : 1;
      ctx.beginPath();
      ctx.moveTo(width * rail.x0, horizon);
      ctx.lineTo(width * rail.x1, height * 1.02);
      ctx.stroke();
      ctx.restore();
    }

    const horizonGlow = ctx.createLinearGradient(0, horizon - 2, 0, horizon + 30);
    horizonGlow.addColorStop(0, 'rgba(68, 219, 232, 0)');
    horizonGlow.addColorStop(.45, 'rgba(69, 205, 228, .16)');
    horizonGlow.addColorStop(1, 'rgba(68, 219, 232, 0)');
    ctx.fillStyle = horizonGlow;
    ctx.fillRect(0, horizon - 2, width, 32);
  }

  function drawEnemy(enemy) {
    const horizon = height * .24;
    const y = horizon + enemy.depth * height * .64;
    const x = enemy.x * width;
    const size = (8 + enemy.depth * 23) * enemy.size;
    const scale = Math.max(.45, size / 24);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    const glowColor = enemy.type === 'drone' ? 'rgba(91, 206, 255, .55)' : 'rgba(255, 174, 96, .42)';
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 12 + enemy.depth * 8;
    if (enemy.type === 'drone') {
      ctx.rotate(Math.sin(elapsed * 1.4 + enemy.phase) * .13);
      ctx.fillStyle = '#304f78';
      ctx.strokeStyle = '#8dddf0';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, -11);
      ctx.lineTo(12, -2);
      ctx.lineTo(8, 8);
      ctx.lineTo(0, 11);
      ctx.lineTo(-8, 8);
      ctx.lineTo(-12, -2);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#b9f9ff';
      ctx.beginPath(); ctx.arc(0, 0, 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(139, 229, 255, .65)';
      ctx.beginPath(); ctx.moveTo(-17, 0); ctx.lineTo(-11, 0); ctx.moveTo(11, 0); ctx.lineTo(17, 0); ctx.stroke();
    } else {
      ctx.rotate(Math.sin(elapsed * .9 + enemy.phase) * .16 + enemy.phase * .15);
      ctx.fillStyle = '#70543d';
      ctx.strokeStyle = '#e6b576';
      ctx.lineWidth = 1.15;
      ctx.beginPath();
      ctx.moveTo(-2, -12); ctx.lineTo(7, -10); ctx.lineTo(12, -3); ctx.lineTo(8, 4);
      ctx.lineTo(5, 12); ctx.lineTo(-4, 10); ctx.lineTo(-11, 5); ctx.lineTo(-12, -3); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(27, 31, 43, .7)';
      ctx.beginPath(); ctx.arc(4, -2, 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(-5, 4, 1.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawBullet(bullet) {
    const x = bullet.x * width;
    const y = bullet.y;
    ctx.save();
    const grad = ctx.createLinearGradient(x, y - bullet.trail, x, y + 4);
    grad.addColorStop(0, 'rgba(96, 239, 245, 0)');
    grad.addColorStop(.72, 'rgba(111, 243, 248, .45)');
    grad.addColorStop(1, '#e3ffff');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 3;
    ctx.shadowColor = '#63e6f3';
    ctx.shadowBlur = 9;
    ctx.beginPath(); ctx.moveTo(x, y - bullet.trail); ctx.lineTo(x, y + 2); ctx.stroke();
    ctx.restore();
  }

  function drawShip() {
    const x = playerX * width;
    const y = height * .78;
    const size = Math.min(width * .035, 23);
    const invulnVisible = invulnerable > 0 && Math.floor(elapsed * 14) % 2 === 0;
    if (invulnVisible) return;
    ctx.save();
    ctx.translate(x, y);
    const flame = 9 + Math.sin(elapsed * 23) * 3 + Math.random() * 2;
    const flameGradient = ctx.createLinearGradient(0, 6, 0, flame + 8);
    flameGradient.addColorStop(0, 'rgba(112, 245, 247, .9)');
    flameGradient.addColorStop(.45, 'rgba(69, 151, 255, .65)');
    flameGradient.addColorStop(1, 'rgba(71, 110, 255, 0)');
    ctx.fillStyle = flameGradient;
    ctx.beginPath(); ctx.moveTo(-size * .21, size * .25); ctx.lineTo(0, flame + 9); ctx.lineTo(size * .21, size * .25); ctx.closePath(); ctx.fill();

    ctx.shadowColor = 'rgba(98, 231, 255, .65)';
    ctx.shadowBlur = 14;
    const hullGradient = ctx.createLinearGradient(-size, -size, size, size);
    hullGradient.addColorStop(0, '#c8fdff');
    hullGradient.addColorStop(.3, '#55d8e8');
    hullGradient.addColorStop(.7, '#3470a5');
    hullGradient.addColorStop(1, '#172d50');
    ctx.fillStyle = hullGradient;
    ctx.strokeStyle = 'rgba(217, 255, 255, .85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -size * 1.04);
    ctx.lineTo(size * .25, -size * .18);
    ctx.lineTo(size * .92, size * .56);
    ctx.lineTo(size * .45, size * .44);
    ctx.lineTo(size * .25, size * .88);
    ctx.lineTo(0, size * .58);
    ctx.lineTo(-size * .25, size * .88);
    ctx.lineTo(-size * .45, size * .44);
    ctx.lineTo(-size * .92, size * .56);
    ctx.lineTo(-size * .25, -size * .18);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#d9ffff';
    ctx.beginPath(); ctx.moveTo(0, -size * .59); ctx.lineTo(size * .14, -size * .06); ctx.lineTo(0, size * .12); ctx.lineTo(-size * .14, -size * .06); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(185, 250, 255, .5)';
    ctx.beginPath(); ctx.moveTo(-size * .72, size * .44); ctx.lineTo(-size * .35, size * .16); ctx.moveTo(size * .72, size * .44); ctx.lineTo(size * .35, size * .16); ctx.stroke();
    ctx.restore();
  }

  function drawParticles() {
    for (const particle of particles) {
      const alpha = clamp(particle.life / particle.max, 0, 1);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = particle.color;
      ctx.shadowColor = particle.color;
      ctx.shadowBlur = 7;
      ctx.beginPath(); ctx.arc(particle.x, particle.y, particle.size * (.55 + alpha * .45), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  function draw() {
    drawBackground();
    drawRails();
    for (const enemy of enemies) drawEnemy(enemy);
    for (const bullet of bullets) drawBullet(bullet);
    drawParticles();
    drawShip();

    if (hitFlash > 0) {
      ctx.fillStyle = `rgba(255, 66, 87, ${clamp(hitFlash / .3, 0, 1) * .18})`;
      ctx.fillRect(0, 0, width, height);
    }
  }

  function frame(now) {
    const dt = Math.min(.04, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
