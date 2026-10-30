"use strict";

(() => {
  const canvas = document.getElementById("atmosphere-canvas");
  if (!canvas) return;

  let context;
  try {
    context = canvas.getContext("2d", { alpha: true });
  } catch {
    return;
  }
  if (!context) return;

  const root = document.documentElement;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const frameInterval = 1000 / 30;
  const maxMotes = 80;
  const maxSparks = 20;
  const motes = [];
  const sparks = [];
  const ripples = [];
  const pointer = { x: 0, y: 0, targetX: 0, targetY: 0, active: false, strength: 0 };
  let width = 1;
  let height = 1;
  let sceneTime = 0;
  let lastFrame = 0;
  let frameId = null;
  let pageActive = true;
  let isRunning = false;
  let hoveredCard = null;

  function motionAllowed() {
    return !root.classList.contains("motion-paused") && (!reducedMotion.matches || root.classList.contains("motion-opt-in"));
  }

  function shouldAnimate() {
    return pageActive && !document.hidden && motionAllowed();
  }

  function makeMote() {
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      radius: .6 + Math.random() * 1.55,
      speed: 5 + Math.random() * 13,
      phase: Math.random() * Math.PI * 2,
      shimmer: .14 + Math.random() * .35,
      drift: Math.random() * 8 - 4,
      vx: 0,
      vy: 0,
      gold: Math.random() > .4,
      star: Math.random() > .87,
    };
  }

  function resize() {
    const previousWidth = width;
    const previousHeight = height;
    width = Math.max(1, window.innerWidth);
    height = Math.max(1, window.innerHeight);
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);

    for (const mote of motes) {
      mote.x *= width / previousWidth;
      mote.y *= height / previousHeight;
    }
    const count = Math.min(maxMotes, Math.max(26, Math.round(width * height / 14500)));
    motes.length = Math.min(motes.length, count);
    while (motes.length < count) motes.push(makeMote());
    if (!pointer.active) {
      pointer.x = pointer.targetX = width * .6;
      pointer.y = pointer.targetY = height * .34;
    }
    if (pageActive && !document.hidden) draw();
  }

  function drawGlow(x, y, radius, color, opacity) {
    const glow = context.createRadialGradient(x, y, 0, x, y, radius);
    glow.addColorStop(0, `rgba(${color}, ${opacity})`);
    glow.addColorStop(.46, `rgba(${color}, ${opacity * .45})`);
    glow.addColorStop(1, `rgba(${color}, 0)`);
    context.fillStyle = glow;
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  function drawStar(x, y, radius, opacity) {
    context.fillStyle = `rgba(218, 197, 143, ${opacity})`;
    context.beginPath();
    context.moveTo(x, y - radius * 2.5);
    context.lineTo(x + radius * .45, y - radius * .45);
    context.lineTo(x + radius * 2.5, y);
    context.lineTo(x + radius * .45, y + radius * .45);
    context.lineTo(x, y + radius * 2.5);
    context.lineTo(x - radius * .45, y + radius * .45);
    context.lineTo(x - radius * 2.5, y);
    context.lineTo(x - radius * .45, y - radius * .45);
    context.closePath();
    context.fill();
  }

  function draw() {
    context.clearRect(0, 0, width, height);
    const reach = Math.min(720, Math.max(width, height) * .66);
    const driftX = Math.sin(sceneTime * .16) * width * .08;
    const driftY = Math.cos(sceneTime * .2) * height * .05;
    const attractX = (pointer.x - width * .5) * pointer.strength * .18;
    const attractY = (pointer.y - height * .5) * pointer.strength * .15;

    // Broad green and amber light stays underneath the readable page surface.
    drawGlow(width * .16 + driftX + attractX, height * .22 + driftY + attractY, reach, "71, 109, 75", .19);
    drawGlow(width * .88 - driftX + attractX, height * .68 - driftY + attractY, reach * .8, "123, 99, 49", .11);
    if (pointer.strength > .005) {
      drawGlow(pointer.x, pointer.y, Math.min(270, width * .6), "196, 176, 111", pointer.strength * .075);
    }

    // A slow, faint curtain makes the background move even between the snowflakes.
    context.beginPath();
    const curtainY = height * .38 + Math.sin(sceneTime * .12) * 60;
    context.moveTo(-40, curtainY);
    context.bezierCurveTo(width * .24, curtainY - 125 + attractY, width * .58, curtainY + 160 + attractY, width + 40, curtainY - 70);
    context.strokeStyle = "rgba(133, 153, 105, .025)";
    context.lineWidth = 65;
    context.stroke();
    context.strokeStyle = "rgba(170, 158, 102, .035)";
    context.lineWidth = 1;
    context.stroke();

    for (const mote of motes) {
      const shimmer = .72 + Math.sin(sceneTime * 1.2 + mote.phase) * .28;
      const opacity = mote.shimmer * shimmer;
      if (mote.star) {
        drawStar(mote.x, mote.y, mote.radius, opacity);
      } else {
        context.fillStyle = `rgba(${mote.gold ? "213, 193, 143" : "232, 226, 205"}, ${opacity})`;
        context.beginPath();
        context.arc(mote.x, mote.y, mote.radius, 0, Math.PI * 2);
        context.fill();
      }
    }

    for (const ripple of ripples) {
      const progress = ripple.age / ripple.life;
      context.beginPath();
      context.arc(ripple.x, ripple.y, 12 + (1 - Math.pow(1 - progress, 3)) * 106, 0, Math.PI * 2);
      context.strokeStyle = `rgba(211, 188, 126, ${(1 - progress) * .19})`;
      context.lineWidth = .8;
      context.stroke();
    }
    for (const spark of sparks) {
      const opacity = (1 - spark.age / spark.life) * .65;
      drawStar(spark.x, spark.y, spark.radius, opacity);
    }
  }

  function update(delta) {
    sceneTime += delta;
    const ease = 1 - Math.exp(-delta * 5);
    pointer.x += (pointer.targetX - pointer.x) * ease;
    pointer.y += (pointer.targetY - pointer.y) * ease;
    pointer.strength += ((pointer.active ? 1 : 0) - pointer.strength) * ease;

    for (const mote of motes) {
      const dx = mote.x - pointer.x;
      const dy = mote.y - pointer.y;
      const distance = Math.hypot(dx, dy);
      if (pointer.strength > .01 && distance > 1 && distance < 170) {
        const force = (1 - distance / 170) * pointer.strength * 43;
        mote.vx += (dx / distance * force - dy / distance * force * .42) * delta;
        mote.vy += (dy / distance * force + dx / distance * force * .42) * delta;
      }
      const friction = Math.exp(-delta * 1.75);
      mote.vx *= friction;
      mote.vy *= friction;
      mote.x += (mote.drift + Math.sin(sceneTime * .65 + mote.phase) * 6 + mote.vx) * delta;
      mote.y += (mote.speed + mote.vy) * delta;
      if (mote.y > height + 12) { mote.y = -12; mote.x = Math.random() * width; }
      if (mote.y < -15) mote.y = height + 10;
      if (mote.x > width + 12) mote.x = -12;
      if (mote.x < -15) mote.x = width + 10;
    }
    for (let index = sparks.length - 1; index >= 0; index -= 1) {
      const spark = sparks[index];
      spark.age += delta;
      if (spark.age >= spark.life) { sparks.splice(index, 1); continue; }
      spark.x += spark.vx * delta;
      spark.y += spark.vy * delta;
      spark.vx *= Math.exp(-delta * 1.8);
      spark.vy = spark.vy * Math.exp(-delta * 1.8) + delta * 13;
    }
    for (let index = ripples.length - 1; index >= 0; index -= 1) {
      ripples[index].age += delta;
      if (ripples[index].age >= ripples[index].life) ripples.splice(index, 1);
    }
  }

  function frame(timestamp) {
    frameId = null;
    if (!shouldAnimate()) {
      syncMotion();
      return;
    }
    if (lastFrame === 0) lastFrame = timestamp - frameInterval;
    const elapsed = timestamp - lastFrame;
    if (elapsed >= frameInterval) {
      update(Math.min(elapsed / 1000, .08));
      draw();
      lastFrame = timestamp;
    }
    frameId = window.requestAnimationFrame(frame);
  }

  function clearCardPointer() {
    if (!hoveredCard) return;
    hoveredCard.style.removeProperty("--pointer-x");
    hoveredCard.style.removeProperty("--pointer-y");
    hoveredCard = null;
  }

  function syncMotion() {
    if (shouldAnimate()) {
      if (!isRunning) {
        isRunning = true;
        lastFrame = 0;
        frameId = window.requestAnimationFrame(frame);
      }
    } else {
      isRunning = false;
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = null;
      lastFrame = 0;
      pointer.active = false;
      pointer.strength = 0;
      sparks.length = 0;
      ripples.length = 0;
      clearCardPointer();
      if (pageActive && !document.hidden) draw();
    }
  }

  function trackPointer(event) {
    if (!shouldAnimate()) return;
    pointer.targetX = event.clientX;
    pointer.targetY = event.clientY;
    pointer.active = true;

    const card = event.target instanceof Element ? event.target.closest(".participant-card:not(:disabled)") : null;
    if (card !== hoveredCard) clearCardPointer();
    if (card) {
      hoveredCard = card;
      const bounds = card.getBoundingClientRect();
      card.style.setProperty("--pointer-x", `${event.clientX - bounds.left}px`);
      card.style.setProperty("--pointer-y", `${event.clientY - bounds.top}px`);
    }
  }

  function burst(event) {
    if (!shouldAnimate() || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    trackPointer(event);
    ripples.push({ x: event.clientX, y: event.clientY, age: 0, life: 1.3 });
    if (ripples.length > 3) ripples.shift();
    for (let index = 0; index < 10; index += 1) {
      const angle = Math.PI * 2 * index / 10 + Math.random() * .3;
      const speed = 28 + Math.random() * 55;
      sparks.push({
        x: event.clientX,
        y: event.clientY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 13,
        radius: .7 + Math.random() * 1.1,
        age: 0,
        life: .7 + Math.random() * .65,
      });
    }
    if (sparks.length > maxSparks) sparks.splice(0, sparks.length - maxSparks);
  }

  function releasePointer() {
    pointer.active = false;
    clearCardPointer();
  }

  window.addEventListener("pointermove", trackPointer, { passive: true });
  window.addEventListener("pointerdown", burst, { passive: true });
  window.addEventListener("pointerup", (event) => {
    if (event.pointerType !== "mouse") releasePointer();
  }, { passive: true });
  window.addEventListener("pointercancel", releasePointer, { passive: true });
  document.addEventListener("pointerleave", releasePointer, { passive: true });
  window.addEventListener("blur", releasePointer);
  window.addEventListener("resize", resize, { passive: true });
  document.addEventListener("visibilitychange", syncMotion);
  window.addEventListener("pagehide", () => {
    pageActive = false;
    syncMotion();
  });
  window.addEventListener("pageshow", () => {
    pageActive = true;
    resize();
    syncMotion();
  });
  reducedMotion.addEventListener("change", syncMotion);
  new MutationObserver(syncMotion).observe(root, { attributes: true, attributeFilter: ["class"] });

  resize();
  syncMotion();
})();
