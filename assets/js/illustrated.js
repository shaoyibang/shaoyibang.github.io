/* =========================================================================
   illustrated.js — 「小街区」交互
   配色切换 / 编号菜单 + 焦点管理 / 建筑招牌气泡 / 场景适配
   ========================================================================= */
(function () {
  "use strict";

  var root = document.documentElement;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* 北京时间：时间戳本身是绝对时间，+8 小时后按 UTC 字段读就是北京的墙上时间。
     别掺 getTimezoneOffset()（那是本机时区；本机正好在 UTC+8 时会得到一个
     "看着像对的"UTC 时间，差 8 小时还不容易被发现）。 */
  function beijingNow() {
    return new Date(Date.now() + 8 * 3600000);
  }

  /* =====================================================================
     1. 配色主题：day / dusk / night / print，选择写进 localStorage
     ===================================================================== */
  var PALETTES = ["day", "dusk", "night", "print"];

  function setPalette(name, save) {
    if (PALETTES.indexOf(name) < 0) name = "day";
    root.dataset.palette = name;
    document.querySelectorAll("[data-palette-set]").forEach(function (b) {
      b.setAttribute("aria-checked", String(b.dataset.paletteSet === name));
    });
    if (save) {
      try { localStorage.setItem("palette", name); } catch (e) { /* 隐私模式 */ }
    }
  }

  document.addEventListener("click", function (e) {
    var dot = e.target.closest("[data-palette-set]");
    if (!dot) return;
    setPalette(dot.dataset.paletteSet, true);
  });

  // 方向键在配色组里切换
  document.addEventListener("keydown", function (e) {
    var dot = e.target.closest && e.target.closest("[data-palette-set]");
    if (!dot) return;
    var i = PALETTES.indexOf(dot.dataset.paletteSet);
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      i = (i + 1) % PALETTES.length;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      i = (i - 1 + PALETTES.length) % PALETTES.length;
    } else {
      return;
    }
    setPalette(PALETTES[i], true);
    var next = document.querySelector('[data-palette-set="' + PALETTES[i] + '"]');
    if (next) next.focus();
  });

  // 首屏在 <head> 里已经应用过，这里只同步 UI 状态
  var saved = "day";
  try { saved = localStorage.getItem("palette") || "day"; } catch (e) { /* ignore */ }
  setPalette(saved, false);

  /* =====================================================================
     2. 编号菜单
     ===================================================================== */
  var menu = document.getElementById("menu");
  var openBtn = document.getElementById("menu-open");
  var closeBtn = document.getElementById("menu-close");
  var lastFocus = null;

  function isOpen() {
    return !!menu && menu.dataset.open === "true";
  }

  function focusables() {
    return Array.prototype.filter.call(menu.querySelectorAll("button, a[href]"), function (el) {
      return el.offsetParent !== null;
    });
  }

  function openMenu() {
    if (!menu || isOpen()) return;
    lastFocus = document.activeElement;
    menu.dataset.open = "true";
    openBtn.setAttribute("aria-expanded", "true");
    document.body.classList.add("is-locked");
    var items = focusables();
    if (items.length) items[0].focus();
  }

  function closeMenu(restore) {
    if (!isOpen()) return;
    menu.dataset.open = "false";
    openBtn.setAttribute("aria-expanded", "false");
    document.body.classList.remove("is-locked");
    if (restore !== false) {
      (lastFocus && lastFocus.focus ? lastFocus : openBtn).focus();
    }
  }

  if (menu && openBtn) {
    openBtn.addEventListener("click", openMenu);
    if (closeBtn) closeBtn.addEventListener("click", function () { closeMenu(); });

    menu.addEventListener("click", function (e) {
      if (e.target === menu) { closeMenu(); return; }
      // 点菜单里的链接：先解锁再让浏览器完成跳转（含锚点）
      if (e.target.closest(".menu__item, .menu__social, .menu__mail")) closeMenu(false);
    });

    document.addEventListener("keydown", function (e) {
      var key = e.key || "";

      if (key === "Escape" && isOpen()) {
        e.preventDefault();
        closeMenu();
        return;
      }

      if ((key === "m" || key === "M") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        var t = e.target;
        var typing = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
        if (!typing) {
          e.preventDefault();
          isOpen() ? closeMenu() : openMenu();
        }
        return;
      }

      if (key === "Tab" && isOpen()) {
        var items = focusables();
        if (!items.length) return;
        var first = items[0];
        var last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
  }

  /* =====================================================================
     3. 建筑招牌气泡：点一下就"咚"地弹出一块招牌，然后滚过去
     ===================================================================== */
  var signEl = document.getElementById("sign");
  var signTimer = null;

  function showSign(hs) {
    if (!signEl) return;
    var r = hs.getBoundingClientRect();
    var label = hs.dataset.label || "";
    var sub = hs.dataset.sub || "";

    signEl.innerHTML = "";
    var b = document.createElement("b");
    b.textContent = label;
    signEl.appendChild(b);
    if (sub) {
      var s = document.createElement("span");
      s.textContent = sub;
      signEl.appendChild(s);
    }

    var half = 130;
    var left = Math.min(Math.max(r.left + r.width / 2, half), window.innerWidth - half);
    signEl.style.left = left + "px";
    signEl.style.top = Math.max(r.top, 84) + "px";
    signEl.classList.add("is-on");

    clearTimeout(signTimer);
    signTimer = setTimeout(function () { signEl.classList.remove("is-on"); }, 1600);
  }

  document.addEventListener("click", function (e) {
    var hs = e.target.closest && e.target.closest(".hotspot");
    if (!hs) return;
    e.preventDefault();

    hs.classList.remove("is-hit");
    void hs.offsetWidth; // 重启动画
    hs.classList.add("is-hit");
    setTimeout(function () { hs.classList.remove("is-hit"); }, 700);

    if (reduceMotion) {
      var target = document.querySelector(hs.dataset.goto || "");
      if (target) target.scrollIntoView({ behavior: "auto", block: "start" });
      return;
    }

    showSign(hs);
    setTimeout(function () {
      var target = document.querySelector(hs.dataset.goto || "");
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 560);
  });

  /* =====================================================================
     4. 场景适配：宽屏铺满，窄屏让整条街缩小贴底
     ===================================================================== */
  (function fitScene() {
    var svg = document.querySelector(".scene svg");
    if (!svg) return;
    var WIDE = { box: "0 0 1440 810", par: "xMidYMax slice" };
    var NARROW = { box: "240 40 960 770", par: "xMidYMax meet" };

    function apply() {
      var narrow = window.innerWidth < 760;
      var cfg = narrow ? NARROW : WIDE;
      if (svg.getAttribute("viewBox") !== cfg.box) svg.setAttribute("viewBox", cfg.box);
      if (svg.getAttribute("preserveAspectRatio") !== cfg.par) {
        svg.setAttribute("preserveAspectRatio", cfg.par);
      }
      root.dataset.sceneFit = narrow ? "narrow" : "wide";
    }

    apply();
    var t;
    window.addEventListener("resize", function () {
      clearTimeout(t);
      t = setTimeout(apply, 150);
    });
  })();

  /* =====================================================================
     5. 左上角北京时间（UTC+8）
     时间戳本身是绝对时间，直接 +8 小时再按 UTC 字段读，就是北京的墙上时间，
     跟访客自己所在的时区无关（不要掺 getTimezoneOffset，那是本机时区）。
     设备时钟本身不准就没办法了。
     ===================================================================== */
  (function clock() {
    var out = document.querySelector("[data-bj-time]");
    if (!out) return;

    var host = out.closest(".clock");
    var timer = null;

    function pad(n) { return n < 10 ? "0" + n : "" + n; }

    function bj() {
      var d = beijingNow(); // 时间戳 + 8h，再用 UTC 字段读
      return {
        y: d.getUTCFullYear(),
        mo: pad(d.getUTCMonth() + 1),
        day: pad(d.getUTCDate()),
        h: pad(d.getUTCHours()),
        mi: pad(d.getUTCMinutes()),
        s: pad(d.getUTCSeconds())
      };
    }

    function render() {
      var t = bj();
      out.textContent = t.h + ":" + t.mi + ":" + t.s;
      if (host) {
        host.dateTime = t.y + "-" + t.mo + "-" + t.day + "T" + t.h + ":" + t.mi + ":" + t.s + "+08:00";
      }
    }

    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
    }

    render();
    timer = setInterval(render, 1000);

    // 标签页切到后台就停掉，回来时立刻补一次：省电，也不会显示一个停住的旧时间
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        stop();
      } else {
        render();
        if (!timer) timer = setInterval(render, 1000);
      }
    });
  })();

  /* =====================================================================
     6. 背景音乐：默认关闭，左上角那个音符开关
     跨页续播是把「开着」和播放位置写进 sessionStorage，换页时接着放。
     浏览器不允许自动播放时就老实回到关闭状态——按钮永远反映真实情况，
     绝不会出现"按钮亮着但其实没声音"。
     ===================================================================== */
  (function bgm() {
    var audio = document.getElementById("bgm");
    var btn = document.getElementById("music-btn");
    if (!audio || !btn) return;

    var VOLUME = 0.85; // 音量固定 85%（iOS 上音量只归硬件管，这个值会被忽略，属正常）

    var KEY_ON = "bgm";
    var KEY_AT = "bgmAt";

    audio.volume = VOLUME;

    function read(k) {
      try { return sessionStorage.getItem(k); } catch (e) { return null; }
    }
    function write(k, v) {
      try { sessionStorage.setItem(k, v); } catch (e) { /* 隐私模式 */ }
    }
    function drop(k) {
      try { sessionStorage.removeItem(k); } catch (e) { /* ignore */ }
    }

    function paint(on) {
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-pressed", String(on));
      btn.setAttribute("aria-label", on ? "关闭背景音乐" : "打开背景音乐");
      btn.title = on ? "背景音乐：开（点一下关掉）" : "背景音乐：关（点一下播放）";
      if (!on) drop(KEY_ON);
    }

    // 记一下播到哪儿了，换页能接上
    var lastSave = 0;
    function remember() {
      if (audio.paused) return;
      var now = Date.now();
      if (now - lastSave < 3000) return;
      lastSave = now;
      write(KEY_ON, "on");
      write(KEY_AT, String(audio.currentTime));
    }

    function start() {
      var p = audio.play();
      if (p && p.then) {
        p.then(function () { paint(true); }).catch(function () { paint(false); });
      } else {
        paint(!audio.paused);
      }
    }

    btn.addEventListener("click", function () {
      if (audio.paused) start();
      else audio.pause();
    });

    audio.addEventListener("play", function () { paint(true); });
    audio.addEventListener("pause", function () { paint(false); });
    audio.addEventListener("ended", function () { paint(false); });
    audio.addEventListener("error", function () { paint(false); });
    audio.addEventListener("timeupdate", remember);
    window.addEventListener("pagehide", remember);

    // 上一页开着的话，这一页接着放；被浏览器拦下就当作没开过
    if (read(KEY_ON) === "on") {
      var at = parseFloat(read(KEY_AT) || "0");
      if (at > 0) {
        audio.addEventListener("loadedmetadata", function () {
          try { audio.currentTime = at; } catch (e) { /* ignore */ }
        }, { once: true });
      }
      start();
    }
  })();

  /* =====================================================================
     7. 时钟下面那行：距离下一个法定节假日放假还有几天
     用北京日期算（跟上面的时钟同一套换算），所以访客在哪个时区看到的
     天数都一样。表里填的是各节"放假首日"。
     ===================================================================== */
  (function countdown() {
    var host = document.querySelector("[data-countdown]");
    if (!host) return;
    var out = host.querySelector("[data-cd-text]");
    if (!out) return;

    // 各法定节假日的"放假首日"。春节按除夕算（2025 年起除夕是法定假日）。
    // 官方调休安排每年年底由国务院办公厅公布，公布后照公告改对应的那一行就行。
    // 2030 年之后表会用完，那时会自动退回"明年元旦"，不会显示成空白。
    var HOLIDAYS = [
      ["2026-01-01", "元旦"],
      ["2026-02-16", "春节"],
      ["2026-04-05", "清明节"],
      ["2026-05-01", "劳动节"],
      ["2026-06-19", "端午节"],
      ["2026-09-25", "中秋节"],
      ["2026-10-01", "国庆节"],
      ["2027-01-01", "元旦"],
      ["2027-02-05", "春节"],
      ["2027-04-05", "清明节"],
      ["2027-05-01", "劳动节"],
      ["2027-06-09", "端午节"],
      ["2027-09-15", "中秋节"],
      ["2027-10-01", "国庆节"],
      ["2028-01-01", "元旦"],
      ["2028-01-25", "春节"],
      ["2028-04-04", "清明节"],
      ["2028-05-01", "劳动节"],
      ["2028-05-28", "端午节"],
      ["2028-10-01", "国庆节"],
      ["2028-10-03", "中秋节"],
      ["2029-01-01", "元旦"],
      ["2029-02-12", "春节"],
      ["2029-04-04", "清明节"],
      ["2029-05-01", "劳动节"],
      ["2029-06-16", "端午节"],
      ["2029-09-22", "中秋节"],
      ["2029-10-01", "国庆节"],
      ["2030-01-01", "元旦"],
      ["2030-02-02", "春节"],
      ["2030-04-05", "清明节"],
      ["2030-05-01", "劳动节"],
      ["2030-06-05", "端午节"],
      ["2030-09-12", "中秋节"],
      ["2030-10-01", "国庆节"]
    ];

    function dayStart(y, m, d) {
      return Date.UTC(y, m, d); // 用 UTC 零点当"这天"，跟北京日期对齐
    }

    var n = beijingNow();
    var today = dayStart(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());

    var next = null;
    for (var i = 0; i < HOLIDAYS.length; i++) {
      var p = HOLIDAYS[i][0].split("-");
      var at = dayStart(+p[0], +p[1] - 1, +p[2]);
      if (at >= today) {
        next = { at: at, name: HOLIDAYS[i][1] };
        break;
      }
    }
    if (!next) {
      var y = n.getUTCFullYear() + 1;
      next = { at: dayStart(y, 0, 1), name: "元旦" };
    }

    var days = Math.round((next.at - today) / 86400000);
    var d = new Date(next.at);
    host.title = next.name + " · " + d.getUTCFullYear() + " 年 " + (d.getUTCMonth() + 1) +
      " 月 " + d.getUTCDate() + " 日";

    out.textContent = "";
    if (days === 0) {
      out.appendChild(document.createTextNode("今天就是" + next.name + " 🎉"));
    } else {
      out.appendChild(document.createTextNode("距离" + next.name + "放假还有 "));
      var num = document.createElement("b");
      num.textContent = String(days);
      out.appendChild(num);
      out.appendChild(document.createTextNode(" 天"));
    }

    host.hidden = false; // 脚本没跑起来就一直藏着，不会露出半个空壳
  })();
})();
