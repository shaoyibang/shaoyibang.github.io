/* =========================================================================
   site.js — 交互
   编号菜单 + 焦点管理 / 北京时间 / 节假日倒计时 / 背景音乐 / 滚动出现

   这个站的原则是"先让它不用 JS 也能用"：下面每一段都只是增强，
   脚本整个挂掉，页面依然能读完、能导航、能换页。
   ========================================================================= */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* 北京时间：时间戳本身是绝对时间，+8 小时后按 UTC 字段读就是北京的墙上时间。
     别掺 getTimezoneOffset()（那是本机时区；本机正好在 UTC+8 时会得到一个
     "看着像对的"UTC 时间，差 8 小时还不容易被发现）。 */
  function beijingNow() {
    return new Date(Date.now() + 8 * 3600000);
  }

  /* =====================================================================
     1. 编号菜单（M 打开 / Esc 关闭 / Tab 锁在弹窗内）
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
    if (openBtn) openBtn.setAttribute("aria-expanded", "true");
    document.body.classList.add("is-locked");
    var items = focusables();
    if (items.length) items[0].focus();
  }

  function closeMenu(restore) {
    if (!isOpen()) return;
    menu.dataset.open = "false";
    if (openBtn) openBtn.setAttribute("aria-expanded", "false");
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
     2. 顶栏的北京时间（UTC+8）
     时间戳直接 +8h 再按 UTC 字段读就是北京墙上时间，跟访客时区无关。
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

    // 标签页切到后台就停掉，回来立刻补一次：省电，也不会显示一个停住的旧时间
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
     3. 时钟旁边那行：距离下一个法定节假日放假还有几天
     用北京日期算（跟时钟同一套换算），访客在任何时区看到的天数都一样。
     表里填的是各节"放假首日"。
     ===================================================================== */
  (function countdown() {
    var host = document.querySelector("[data-countdown]");
    if (!host) return;
    var out = host.querySelector("[data-cd-text]");
    if (!out) return;

    // 各法定节假日的"放假首日"。春节按除夕算（2025 年起除夕是法定假日）。
    // 官方调休安排每年年底由国务院办公厅公布，公布后照公告改对应的那一行。
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
      out.appendChild(document.createTextNode("今天就是" + next.name));
    } else {
      out.appendChild(document.createTextNode("距离" + next.name + "放假还有 "));
      var num = document.createElement("b");
      num.textContent = String(days);
      out.appendChild(num);
      out.appendChild(document.createTextNode(" 天"));
    }

    host.hidden = false; // 脚本没跑起来就一直藏着，不会露出半个空壳
  })();

  /* =====================================================================
     4. 背景音乐：默认关闭，顶栏那个音符开关
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

    paint(false);
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
     5. 滚动出现：只加不加不减，元素默认是可见的

     注意这里的顺序 —— 先无条件把"已经进入视口"的元素显示出来，再交给
     IntersectionObserver 处理剩下的。如果只依赖 observer 的回调，一旦它
     因为任何原因没有触发（异步时序、宿主环境差异），首屏内容就会永远停在
     opacity:0 上。宁可少一个动画，也不能让内容看不见。
     ===================================================================== */
  (function reveal() {
    var items = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
    if (!items.length) return;

    function show(el) { el.classList.add("is-in"); }

    if (reduceMotion || !("IntersectionObserver" in window)) {
      items.forEach(show);
      return;
    }

    // 首屏兜底：这一帧就在视口内的，直接显示
    requestAnimationFrame(function () {
      items.forEach(function (el) {
        if (el.classList.contains("is-in")) return;
        var r = el.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0) show(el);
      });
    });

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        show(entry.target);
        io.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.06 });

    items.forEach(function (el) {
      if (!el.classList.contains("is-in")) io.observe(el);
    });

    // 再兜一层：3 秒后还没显示的统统显示，避免任何情况下内容被藏住
    setTimeout(function () { items.forEach(show); }, 3000);
  })();
})();
