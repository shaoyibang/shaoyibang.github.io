/* =========================================================================
   main.js — 全站通用交互
   导航高亮 / 主题切换 / 命令面板 (Cmd+K) / 热力图 / 随机一句 / 入场动画
   ========================================================================= */
(function () {
  "use strict";

  var root = document.documentElement;
  var BASE = root.dataset.base || ".";
  var url = function (p) {
    return BASE + "/" + p;
  };

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- 图标（Lucide 风格，24x24 viewBox） ---------- */
  var ICONS = {
    home: '<path d="M3 10.4 12 3l9 7.4"/><path d="M5.5 9.2V21h13V9.2"/>',
    works: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/>',
    blog: '<path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5"/><path d="M8.5 13h7M8.5 17h5"/>',
    tools: '<rect x="2.5" y="7" width="19" height="10" rx="5"/><path d="M7.5 10v4M5.5 12h4"/><circle cx="16" cy="11" r="1"/><circle cx="18.5" cy="13.5" r="1"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    shuffle: '<path d="M16 3h5v5"/><path d="M21 3 3 21"/><path d="M21 16v5h-5"/><path d="M3 3l6 6"/>',
    arrowUp: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    arrowLeft: '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'
  };

  function icon(name) {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || "") +
      "</svg>"
    );
  }

  /* ---------- 提示条 ---------- */
  var toastEl = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      toastEl.setAttribute("role", "status");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("is-on");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      toastEl.classList.remove("is-on");
    }, 1800);
  }

  /* ---------- 主题 ---------- */
  function currentTheme() {
    return root.dataset.theme === "dark" ? "dark" : "light";
  }

  function paintThemeBtn() {
    var btn = document.querySelector("[data-theme-toggle]");
    if (!btn) return;
    var dark = currentTheme() === "dark";
    btn.innerHTML = icon(dark ? "sun" : "moon");
    btn.setAttribute("aria-label", dark ? "切换到浅色模式" : "切换到深色模式");
    btn.setAttribute("title", dark ? "浅色模式" : "深色模式");
  }

  function toggleTheme() {
    var next = currentTheme() === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch (e) {
      /* 隐私模式下忽略 */
    }
    paintThemeBtn();
    toast(next === "dark" ? "已切换到深色模式" : "已切换到浅色模式");
  }

  /* ---------- 导航高亮 ---------- */
  function markActiveNav() {
    var here = location.pathname.split("/").pop() || "index.html";
    var seg = location.pathname.indexOf("/blog/") > -1 ? "blog" : here.replace(/\.html$/, "");
    var map = { index: "home", works: "works", tools: "tools", blog: "blog" };
    var key = map[seg] || map[here.replace(/\.html$/, "")] || "home";
    document.querySelectorAll("[data-nav]").forEach(function (el) {
      var on = el.dataset.nav === key;
      el.classList.toggle("is-active", on);
      if (on) {
        el.setAttribute("aria-current", "page");
      } else {
        el.removeAttribute("aria-current");
      }
    });
  }

  /* ---------- 贡献热力图 ---------- */
  function renderHeat() {
    var host = document.querySelector("[data-heat]");
    if (!host) return;
    var weeks = 26;
    var seed = 20260214;
    function rnd() {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    }
    var cells = [];
    for (var w = 0; w < weeks; w++) {
      for (var d = 0; d < 7; d++) {
        var weekend = d === 0 || d === 6;
        var r = rnd();
        var level = 0;
        if (r > (weekend ? 0.82 : 0.52)) level = 1;
        if (r > (weekend ? 0.93 : 0.74)) level = 2;
        if (r > (weekend ? 0.98 : 0.9)) level = 3;
        if (r > 0.985) level = 4;
        cells.push('<i data-l="' + level + '"></i>');
      }
    }
    host.innerHTML = cells.join("");
    var total = cells.filter(function (c) {
      return c.indexOf('data-l="0"') === -1;
    }).length;
    var out = document.querySelector("[data-heat-total]");
    if (out) out.textContent = total * 3 + " 次提交";
  }

  /* ---------- 随机一句 ---------- */
  var QUOTES = [
    ["好的界面不解释自己，它只是让人不迷路。", "关于设计"],
    ["先把东西做出来，再谈优雅。", "关于工程"],
    ["复杂是容易的，简单需要勇气。", "关于取舍"],
    ["任何一个玩具，只要有人愿意玩第二次，它就成立了。", "关于有趣"],
    ["别优化没有用户的那条路径。", "关于优先级"],
    ["写文档是给三个月后的自己留的救生圈。", "关于习惯"],
    ["慢一点，但别停。", "关于长期"]
  ];

  function shuffleQuote() {
    var t = document.querySelector("[data-quote-text]");
    var f = document.querySelector("[data-quote-from]");
    if (!t) return;
    var i = Math.floor(Math.random() * QUOTES.length);
    var pick = QUOTES[i];
    if (t.textContent === pick[0] && QUOTES.length > 1) {
      pick = QUOTES[(i + 1) % QUOTES.length];
    }
    t.textContent = pick[0];
    if (f) f.textContent = "— " + pick[1];
  }

  /* ---------- 命令面板 ---------- */
  var cmdk = null;
  var cmdkInput = null;
  var cmdkList = null;
  var filtered = [];
  var cursor = 0;

  function commands() {
    return [
      { label: "首页", hint: "Home", icon: "home", run: function () { go(url("index.html")); } },
      { label: "作品集", hint: "Works", icon: "works", keywords: "zuopin project", run: function () { go(url("works.html")); } },
      { label: "博客文章", hint: "Blog", icon: "blog", keywords: "wenzhang post", run: function () { go(url("blog/index.html")); } },
      { label: "工具实验室", hint: "Tools", icon: "tools", keywords: "gongju tools", run: function () { go(url("tools.html")); } },
      { label: "切换深色 / 浅色模式", hint: "Theme", icon: "moon", keywords: "theme dark light moshi", run: toggleTheme },
      { label: "换一句随机的话", hint: "Shuffle", icon: "shuffle", keywords: "quote suiji", run: shuffleQuote },
      { label: "复制邮箱地址", hint: "Copy", icon: "mail", keywords: "email youxiang contact", run: copyMail },
      { label: "回到顶部", hint: "Top", icon: "arrowUp", keywords: "top dingbu", run: function () { window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" }); } }
    ];
  }

  function go(href) {
    location.href = href;
  }

  function copyMail() {
    var mail = document.body.dataset.email || "hi@example.com";
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(mail).then(
        function () { toast("邮箱已复制：" + mail); },
        function () { toast(mail); }
      );
    } else {
      toast(mail);
    }
  }

  function buildCmdk() {
    if (cmdk) return;
    cmdk = document.createElement("div");
    cmdk.className = "cmdk";
    cmdk.hidden = true;
    cmdk.setAttribute("role", "dialog");
    cmdk.setAttribute("aria-modal", "true");
    cmdk.setAttribute("aria-label", "命令面板");
    cmdk.innerHTML =
      '<div class="cmdk__box">' +
      '<input class="cmdk__input" type="text" placeholder="搜索页面或命令…" ' +
      'aria-label="搜索命令" autocomplete="off" spellcheck="false">' +
      '<div class="cmdk__list" role="listbox" aria-label="命令列表"></div>' +
      "</div>";
    document.body.appendChild(cmdk);
    cmdkInput = cmdk.querySelector(".cmdk__input");
    cmdkList = cmdk.querySelector(".cmdk__list");

    cmdkInput.addEventListener("input", function () {
      cursor = 0;
      renderCmdk(cmds_filtered(cmdkInput.value));
    });

    cmdkInput.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        cursor = Math.min(cursor + 1, filtered.length - 1);
        paintCursor();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        cursor = Math.max(cursor - 1, 0);
        paintCursor();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[cursor]) runCmd(filtered[cursor], true);
      } else if (e.key === "Escape") {
        closeCmdk();
      }
    });

    cmdk.addEventListener("click", function (e) {
      if (e.target === cmdk) closeCmdk();
    });
  }

  function cmds_filtered(q) {
    var list = commands();
    q = (q || "").trim().toLowerCase();
    if (!q) return list;
    return list.filter(function (c) {
      var hay = (c.label + " " + (c.keywords || "") + " " + c.hint).toLowerCase();
      return hay.indexOf(q) > -1;
    });
  }

  function runCmd(cmd, close) {
    if (close) closeCmdk();
    setTimeout(function () {
      cmd.run();
    }, close ? 40 : 0);
  }

  function renderCmdk(list) {
    filtered = list;
    if (!list.length) {
      cmdkList.innerHTML = '<p class="cmdk__empty">没有匹配的命令，换个词试试</p>';
      return;
    }
    cmdkList.innerHTML = list
      .map(function (c, i) {
        return (
          '<button class="cmdk__item' + (i === cursor ? " is-active" : "") + '" role="option" ' +
          'aria-selected="' + (i === cursor) + '" data-i="' + i + '">' +
          icon(c.icon) +
          "<span>" + c.label + "</span><small>" + c.hint + "</small></button>"
        );
      })
      .join("");
    cmdkList.querySelectorAll(".cmdk__item").forEach(function (b) {
      b.addEventListener("click", function () {
        runCmd(filtered[Number(b.dataset.i)], true);
      });
      b.addEventListener("mousemove", function () {
        cursor = Number(b.dataset.i);
        paintCursor();
      });
    });
  }

  function paintCursor() {
    cmdkList.querySelectorAll(".cmdk__item").forEach(function (b, i) {
      var on = i === cursor;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
    });
  }

  function openCmdk() {
    buildCmdk();
    cmdk.hidden = false;
    cursor = 0;
    renderCmdk(cmds_filtered(""));
    cmdkInput.value = "";
    cmdkInput.focus();
  }

  function closeCmdk() {
    if (!cmdk) return;
    cmdk.hidden = true;
  }

  /* ---------- 入场动画 ---------- */
  function setupReveal() {
    var items = document.querySelectorAll(".reveal");
    if (!items.length) return;
    if (reduceMotion || !("IntersectionObserver" in window)) {
      items.forEach(function (el) {
        el.classList.add("is-in");
      });
      return;
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            en.target.classList.add("is-in");
            io.unobserve(en.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );
    items.forEach(function (el) {
      io.observe(el);
    });
  }

  /* ---------- 事件绑定 ---------- */
  document.addEventListener("keydown", function (e) {
    var key = e.key ? e.key.toLowerCase() : "";
    if ((e.metaKey || e.ctrlKey) && key === "k") {
      e.preventDefault();
      cmdk && !cmdk.hidden ? closeCmdk() : openCmdk();
      return;
    }
    if (key === "/" && !/^(input|textarea|select)$/i.test((e.target.tagName || ""))) {
      e.preventDefault();
      openCmdk();
      return;
    }
    if (key === "escape") closeCmdk();
  });

  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-cmdk-open]");
    if (t) {
      e.preventDefault();
      openCmdk();
      return;
    }
    if (e.target.closest("[data-theme-toggle]")) {
      toggleTheme();
      return;
    }
    if (e.target.closest("[data-shuffle-quote]")) {
      shuffleQuote();
    }
  });

  /* ---------- 初始化 ---------- */
  function init() {
    markActiveNav();
    paintThemeBtn();
    renderHeat();
    setupReveal();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.SiteUI = { toast: toast, icon: icon, openCmdk: openCmdk, shuffleQuote: shuffleQuote };
})();
