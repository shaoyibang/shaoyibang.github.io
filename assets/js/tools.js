/* =========================================================================
   tools.js — 三个浏览器小工具：涂鸦板 / 贪吃蛇 / 生命游戏
   纯 Canvas 2D，无依赖。所有坐标都按 canvas 内部坐标系换算，因此可以自由缩放。
   ========================================================================= */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  /** 把指针事件换算成 canvas 内部坐标 */
  function localPoint(canvas, e) {
    var r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * canvas.width,
      y: ((e.clientY - r.top) / r.height) * canvas.height
    };
  }

  function toast(msg) {
    if (window.SiteUI && window.SiteUI.toast) window.SiteUI.toast(msg);
  }

  /* =======================================================================
     1. 涂鸦板
     ======================================================================= */
  (function doodle() {
    var canvas = document.getElementById("doodle-canvas");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var color = "#1d1d1f";
    var size = 8;
    var drawing = false;
    var last = null;

    function clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = cssVar("--surface-2", "#fafafa");
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    clear();

    function stroke(a, b) {
      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    canvas.addEventListener("pointerdown", function (e) {
      drawing = true;
      canvas.setPointerCapture(e.pointerId);
      last = localPoint(canvas, e);
      stroke(last, { x: last.x + 0.1, y: last.y + 0.1 });
    });

    canvas.addEventListener("pointermove", function (e) {
      if (!drawing) return;
      var p = localPoint(canvas, e);
      stroke(last, p);
      last = p;
    });

    ["pointerup", "pointercancel"].forEach(function (type) {
      canvas.addEventListener(type, function () {
        drawing = false;
        last = null;
      });
    });

    document.querySelectorAll("[data-doodle-color]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        color = btn.dataset.doodleColor;
        document.querySelectorAll("[data-doodle-color]").forEach(function (b) {
          b.setAttribute("aria-pressed", String(b === btn));
        });
      });
    });

    var range = document.querySelector("[data-doodle-size]");
    if (range) {
      range.addEventListener("input", function () {
        size = Number(range.value);
        var out = document.querySelector("[data-doodle-size-out]");
        if (out) out.textContent = size + "px";
      });
    }

    var clearBtn = document.querySelector("[data-doodle-clear]");
    if (clearBtn) clearBtn.addEventListener("click", function () { clear(); toast("画布已清空"); });

    var saveBtn = document.querySelector("[data-doodle-save]");
    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        try {
          var a = document.createElement("a");
          a.download = "doodle-" + Date.now() + ".png";
          a.href = canvas.toDataURL("image/png");
          a.click();
          toast("已导出 PNG");
        } catch (err) {
          toast("导出失败，试试换个浏览器");
        }
      });
    }
  })();

  /* =======================================================================
     2. 贪吃蛇
     ======================================================================= */
  (function snake() {
    var canvas = document.getElementById("snake-canvas");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var COLS = 24;
    var ROWS = 16;
    var CELL = canvas.width / COLS; // 960 / 24 = 40

    var snake, dir, pending, food, score, running, dead, acc, lastT, raf;
    var STEP = reduceMotion ? 150 : 115;

    var scoreEl = document.querySelector("[data-snake-score]");
    var bestEl = document.querySelector("[data-snake-best]");
    var best = 0;
    try {
      best = Number(localStorage.getItem("snake-best") || 0);
    } catch (e) {
      best = 0;
    }

    function paintStats() {
      if (scoreEl) scoreEl.textContent = "得分 " + score;
      if (bestEl) bestEl.textContent = "最高 " + best;
    }

    function syncToggle() {
      var b = document.querySelector("[data-snake-toggle]");
      if (!b) return;
      b.textContent = dead ? "重开" : running ? "暂停" : "开始";
    }

    function placeFood() {
      var free = [];
      for (var y = 0; y < ROWS; y++) {
        for (var x = 0; x < COLS; x++) {
          if (!snake.some(function (s) { return s.x === x && s.y === y; })) free.push({ x: x, y: y });
        }
      }
      food = free.length ? free[Math.floor(Math.random() * free.length)] : { x: 0, y: 0 };
    }

    function reset() {
      snake = [{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 6, y: 8 }];
      dir = { x: 1, y: 0 };
      pending = null;
      score = 0;
      dead = false;
      running = false;
      acc = 0;
      lastT = 0;
      placeFood();
      paintStats();
      syncToggle();
      draw();
    }

    function step() {
      if (pending) {
        var ok = pending.x !== -dir.x || pending.y !== -dir.y;
        if (ok && (pending.x !== dir.x || pending.y !== dir.y)) dir = pending;
        pending = null;
      }
      var head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

      if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS) return gameOver();
      var hitSelf = snake.some(function (s, i) {
        return i < snake.length - 1 && s.x === head.x && s.y === head.y;
      });
      if (hitSelf) return gameOver();

      snake.unshift(head);
      if (head.x === food.x && head.y === food.y) {
        score += 1;
        if (score > best) {
          best = score;
          try { localStorage.setItem("snake-best", String(best)); } catch (e) { /* ignore */ }
        }
        placeFood();
        paintStats();
      } else {
        snake.pop();
      }
      draw();
    }

    function gameOver() {
      dead = true;
      running = false;
      paintStats();
      syncToggle();
      draw();
      toast("撞上了 · 得分 " + score);
    }

    function draw() {
      var surface = cssVar("--surface-2", "#fafafa");
      var border = cssVar("--border", "#e4e4e7");
      var accent = cssVar("--accent", "#2563eb");
      var text = cssVar("--text", "#1d1d1f");
      var muted = cssVar("--muted", "#52525b");

      ctx.fillStyle = surface;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      for (var gx = 1; gx < COLS; gx++) {
        ctx.beginPath();
        ctx.moveTo(gx * CELL, 0);
        ctx.lineTo(gx * CELL, canvas.height);
        ctx.stroke();
      }
      for (var gy = 1; gy < ROWS; gy++) {
        ctx.beginPath();
        ctx.moveTo(0, gy * CELL);
        ctx.lineTo(canvas.width, gy * CELL);
        ctx.stroke();
      }

      // 食物
      ctx.fillStyle = cssVar("--lime", "#c6ff00");
      ctx.beginPath();
      ctx.arc(food.x * CELL + CELL / 2, food.y * CELL + CELL / 2, CELL * 0.3, 0, Math.PI * 2);
      ctx.fill();

      // 蛇身
      snake.forEach(function (s, i) {
        ctx.fillStyle = i === 0 ? accent : text;
        ctx.globalAlpha = i === 0 ? 1 : Math.max(0.35, 1 - i / (snake.length + 4));
        var pad = i === 0 ? 2 : 4;
        roundRect(s.x * CELL + pad, s.y * CELL + pad, CELL - pad * 2, CELL - pad * 2, 8);
        ctx.fill();
      });
      ctx.globalAlpha = 1;

      if (!running && !dead) {
        overlay("点击画面，然后按方向键开始", text);
      } else if (dead) {
        overlay("游戏结束 · 再按一次方向键重开", muted);
      }
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function overlay(msg, color) {
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.42)";
      ctx.fillRect(0, canvas.height / 2 - 34, canvas.width, 68);
      ctx.fillStyle = "#fff";
      ctx.font = "600 24px " + cssVar("--font-display", "sans-serif");
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
      ctx.restore();
    }

    function loop(t) {
      raf = requestAnimationFrame(loop);
      if (!running) return;
      if (!lastT) lastT = t;
      acc += t - lastT;
      lastT = t;
      while (acc >= STEP) {
        acc -= STEP;
        step();
        if (!running) break;
      }
    }

    function start() {
      if (dead) reset();
      if (running) return;
      running = true;
      lastT = 0;
      acc = 0;
      syncToggle();
      draw();
    }

    function pause() {
      if (dead) return;
      running = false;
      syncToggle();
      draw();
    }

    function turn(x, y) {
      if (dead) {
        reset();
        start();
        return;
      }
      pending = { x: x, y: y };
      if (!running) start();
    }

    var KEYS = {
      arrowup: [0, -1], w: [0, -1],
      arrowdown: [0, 1], s: [0, 1],
      arrowleft: [-1, 0], a: [-1, 0],
      arrowright: [1, 0], d: [1, 0]
    };

    canvas.addEventListener("keydown", function (e) {
      var k = (e.key || "").toLowerCase();
      if (!KEYS[k]) {
        if (k === " " || k === "enter") {
          e.preventDefault();
          running ? pause() : start();
        }
        return;
      }
      e.preventDefault();
      turn(KEYS[k][0], KEYS[k][1]);
    });

    canvas.addEventListener("pointerdown", function () {
      canvas.focus();
      if (!running && !dead) start();
    });

    document.querySelectorAll("[data-snake-dir]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var map = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
        var d = map[btn.dataset.snakeDir];
        if (d) turn(d[0], d[1]);
      });
    });

    var toggle = document.querySelector("[data-snake-toggle]");
    if (toggle) {
      toggle.addEventListener("click", function () {
        if (running) pause();
        else start();
      });
    }

    var restart = document.querySelector("[data-snake-reset]");
    if (restart) {
      restart.addEventListener("click", function () {
        reset();
        start();
      });
    }

    reset();
    raf = requestAnimationFrame(loop);
    window.addEventListener("pagehide", function () { cancelAnimationFrame(raf); });
  })();

  /* =======================================================================
     3. 生命游戏（Conway's Game of Life）
     ======================================================================= */
  (function life() {
    var canvas = document.getElementById("life-canvas");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var COLS = 48;
    var ROWS = 28;
    var CELL = canvas.width / COLS; // 960 / 48 = 20
    var grid = new Uint8Array(COLS * ROWS);
    var gen = 0;
    var playing = false;
    var acc = 0;
    var lastT = 0;
    var raf;
    var painting = false;
    var paintValue = 1;
    var STEP = 110;

    var statEl = document.querySelector("[data-life-stat]");

    function idx(x, y) {
      return y * COLS + x;
    }

    function seed(density) {
      for (var i = 0; i < grid.length; i++) grid[i] = Math.random() < density ? 1 : 0;
      gen = 0;
      paint();
    }

    function alive() {
      var n = 0;
      for (var i = 0; i < grid.length; i++) n += grid[i];
      return n;
    }

    function paint() {
      if (statEl) statEl.textContent = "第 " + gen + " 代 · 存活 " + alive();
    }

    function draw() {
      var surface = cssVar("--surface-2", "#fafafa");
      var accent = cssVar("--accent", "#2563eb");
      var border = cssVar("--border", "#e4e4e7");

      ctx.fillStyle = surface;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      for (var x = 1; x < COLS; x++) {
        ctx.beginPath();
        ctx.moveTo(x * CELL, 0);
        ctx.lineTo(x * CELL, canvas.height);
        ctx.stroke();
      }
      for (var y = 1; y < ROWS; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * CELL);
        ctx.lineTo(canvas.width, y * CELL);
        ctx.stroke();
      }

      ctx.fillStyle = accent;
      for (var yy = 0; yy < ROWS; yy++) {
        for (var xx = 0; xx < COLS; xx++) {
          if (!grid[idx(xx, yy)]) continue;
          ctx.beginPath();
          ctx.arc(xx * CELL + CELL / 2, yy * CELL + CELL / 2, CELL * 0.36, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    function next() {
      var out = new Uint8Array(COLS * ROWS);
      for (var y = 0; y < ROWS; y++) {
        for (var x = 0; x < COLS; x++) {
          var n = 0;
          for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              var nx = (x + dx + COLS) % COLS; // 环形边界，边缘不会死气沉沉
              var ny = (y + dy + ROWS) % ROWS;
              n += grid[idx(nx, ny)];
            }
          }
          var self = grid[idx(x, y)];
          out[idx(x, y)] = self ? (n === 2 || n === 3 ? 1 : 0) : n === 3 ? 1 : 0;
        }
      }
      grid = out;
      gen++;
      draw();
      paint();
    }

    function loop(t) {
      raf = requestAnimationFrame(loop);
      if (!playing) return;
      if (!lastT) lastT = t;
      acc += t - lastT;
      lastT = t;
      while (acc >= STEP) {
        acc -= STEP;
        next();
      }
    }

    canvas.addEventListener("pointerdown", function (e) {
      painting = true;
      canvas.setPointerCapture(e.pointerId);
      var p = localPoint(canvas, e);
      var x = Math.floor(p.x / CELL);
      var y = Math.floor(p.y / CELL);
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return;
      paintValue = grid[idx(x, y)] ? 0 : 1;
      grid[idx(x, y)] = paintValue;
      draw();
      paint();
    });

    canvas.addEventListener("pointermove", function (e) {
      if (!painting) return;
      var p = localPoint(canvas, e);
      var x = Math.floor(p.x / CELL);
      var y = Math.floor(p.y / CELL);
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return;
      grid[idx(x, y)] = paintValue;
      draw();
      paint();
    });

    ["pointerup", "pointercancel"].forEach(function (type) {
      canvas.addEventListener(type, function () { painting = false; });
    });

    var toggle = document.querySelector("[data-life-toggle]");
    if (toggle) {
      toggle.addEventListener("click", function () {
        playing = !playing;
        lastT = 0;
        acc = 0;
        toggle.textContent = playing ? "暂停" : "播放";
        if (playing && alive() === 0) seed(0.28);
      });
    }

    var stepBtn = document.querySelector("[data-life-step]");
    if (stepBtn) stepBtn.addEventListener("click", function () {
      playing = false;
      if (toggle) toggle.textContent = "播放";
      next();
    });

    var randBtn = document.querySelector("[data-life-random]");
    if (randBtn) randBtn.addEventListener("click", function () { seed(0.28); draw(); paint(); });

    var clearBtn = document.querySelector("[data-life-clear]");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      grid = new Uint8Array(COLS * ROWS);
      gen = 0;
      draw();
      paint();
    });

    // 初始给一个滑翔机枪的近似静态图案，避免打开就是空白
    seed(0.24);
    draw();
    paint();
    raf = requestAnimationFrame(loop);
    window.addEventListener("pagehide", function () { cancelAnimationFrame(raf); });
  })();
})();
