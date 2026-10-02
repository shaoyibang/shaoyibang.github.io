/* =========================================================================
   app.js — 写作工具的界面逻辑

   预览 deliberately 复用 tools/md.mjs（由本地服务以模块形式提供），
   和发布时用的是同一个转换器 —— 否则会出现"编辑器里好看、发出去不一样"。
   ========================================================================= */
import { mdToHtml } from "./md.mjs";

const $ = (id) => document.getElementById(id);
const els = {
  list: $("list"), editor: $("editor"), preview: $("preview"), status: $("status"),
  save: $("save"), build: $("build"), upload: $("upload"), new: $("new"),
  delete: $("delete"), logout: $("logout"),
  openHome: $("open-home"), openBlog: $("open-blog"),
  file: $("file"), drop: $("drop"),
  title: $("f-title"), date: $("f-date"), summary: $("f-summary"),
  cats: $("f-cats"), slug: $("f-slug"),
};

let current = null;   // 当前 slug
let dirty = false;

/* 只有已经存在的文章才能删：新建但还没保存的没有对应文件，
   点删除只会得到一个 404，不如直接禁用。 */
function updateDeleteState() {
  const exists = !!current;
  els.delete.disabled = !exists;
  els.delete.title = exists ? "" : "这篇还没保存，没有可删除的文件";
}

/* ------------------------------------------------------------------ 工具 */
function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = "bar__status" + (kind ? " is-" + kind : "");
}

/* 接口路径写成相对的是必须的，不是风格问题：
   后台在开发模式挂在根上（/api/...），生产模式挂在 /admin/ 下、由反向代理
   把 /admin 前缀剥掉再转发。页面在浏览器里的位置是 /admin/，所以绝对路径
   /api/posts 会打到主站上去（那里没有这个接口），而相对路径 ./api/posts
   在两种挂载下都算得对。调用处仍然写 "/api/xxx"，由这里统一转一次。 */
const apiUrl = (path) => (path.startsWith("/") ? "." + path : path);

async function api(path, options) {
  const res = await fetch(apiUrl(path), options);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  /* 会话过期时后端返回 401：与其显示一句"未登录"，不如直接回登录页。 */
  if (res.status === 401) {
    location.replace("login");
    throw new Error("登录已过期");
  }
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

/* 保存前提醒：Ctrl/Cmd+S */
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save();
  }
});

/* -------------------------------------------------------------- 文章列表 */
async function loadList() {
  const { posts } = await api("/api/posts");
  els.list.innerHTML = "";
  for (const p of posts) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "list__item" + (p.slug === current ? " is-active" : "");
    b.innerHTML = `<b></b><small></small>`;
    b.querySelector("b").textContent = p.title || p.slug;
    b.querySelector("small").textContent = p.date + " · " + p.slug + ".md";
    b.addEventListener("click", () => open(p.slug));
    els.list.appendChild(b);
  }
  return posts;
}

/* ------------------------------------------------------------------ 打开 */
async function open(slug) {
  if (dirty && !confirm("当前修改还没保存，确定要切换吗？")) return;
  const { data, body } = await api("/api/post?slug=" + encodeURIComponent(slug));
  current = slug;
  els.title.value = data.title || "";
  els.date.value = data.date || new Date().toISOString().slice(0, 10);
  els.summary.value = data.summary || "";
  els.cats.value = data.cats || "";
  els.slug.value = slug;
  els.editor.value = body.replace(/^\n+/, "");
  dirty = false;
  updateDeleteState();
  render();
  await loadList();
  setStatus("已打开 " + slug + ".md");
}

/* ------------------------------------------------------------------ 渲染 */
let renderTimer = null;
function render() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    const html = mdToHtml(els.editor.value);
    els.preview.innerHTML = html || '<p class="preview__placeholder">（正文是空的）</p>';
  }, 120);
}

els.editor.addEventListener("input", () => { dirty = true; render(); });

/* ------------------------------------------------------------------ 保存 */
async function save() {
  if (!els.slug.value.trim()) { setStatus("先填文件名", "error"); return; }
  try {
    const payload = {
      original: current,
      slug: els.slug.value.trim(),
      data: {
        title: els.title.value.trim(),
        date: els.date.value,
        summary: els.summary.value.trim(),
        lede: els.summary.value.trim(),
        cats: els.cats.value.trim(),
      },
      body: els.editor.value,
    };
    const res = await api("/api/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    current = res.slug;
    dirty = false;
    await loadList();
    setStatus(`已保存 ${res.slug}.md；` + (res.built?.length
      ? "已重新生成 " + res.built.length + " 个页面"
      : "页面无需重新生成"), "ok");
  } catch (e) {
    setStatus("保存失败：" + e.message, "error");
  }
}

async function build() {
  try {
    const res = await api("/api/build", { method: "POST" });
    setStatus(res.written?.length
      ? "已重新生成 " + res.written.length + " 个页面"
      : "没有变化，未写文件", "ok");
  } catch (e) {
    setStatus("生成失败：" + e.message, "error");
  }
}

/* -------------------------------------------------------------- 删除一篇 */
async function confirmDelete() {
  const slug = current || els.slug.value.trim();
  if (!slug) { setStatus("没有可删除的文章", "error"); return; }

  // 删除只能从 git 里找回，所以要说清楚删的是什么、以及会连带发生什么
  const ok = confirm(
    `确定删除「${els.title.value.trim() || slug}」吗？\n\n` +
    `会删除 blog/posts/${slug}.md，并移除已生成的 blog/${slug}.html。\n` +
    `其他文章的「上一篇 / 下一篇」和随笔列表会一起更新。\n\n` +
    `提交过的话可以从 git 历史里找回；没提交就找不回来了。`
  );
  if (!ok) return;

  try {
    const res = await api("/api/post?slug=" + encodeURIComponent(slug), { method: "DELETE" });
    const detail = [
      `已删除 ${res.slug}.md`,
      res.removed?.length ? "移除页面 " + res.removed.length + " 个" : null,
      res.built?.length ? "重建 " + res.built.length + " 个" : null,
    ].filter(Boolean).join("；");
    setStatus(detail, "ok");

    current = null;
    dirty = false;
    const { posts } = await api("/api/posts");
    await loadList();
    if (posts.length) await open(posts[0].slug);
    else createNew();
  } catch (e) {
    setStatus("删除失败：" + e.message, "error");
  }
}

/* -------------------------------------------------------------- 新建一篇 */
async function createNew() {
  if (dirty && !confirm("当前修改还没保存，确定要新建吗？")) return;
  const today = new Date().toISOString().slice(0, 10);
  const slug = "untitled-" + today;
  current = null;
  els.title.value = "";
  els.date.value = today;
  els.summary.value = "";
  els.cats.value = "";
  els.slug.value = slug;
  els.editor.value = "在这里写正文。\n";
  dirty = true;
  updateDeleteState();
  els.preview.innerHTML = '<p class="preview__placeholder">填好标题后按保存，会创建 blog/posts/' + slug + ".md</p>";
  els.title.focus();
  setStatus("新建：填好标题、摘要和文件名后按保存（Ctrl+S）");
}

/* ------------------------------------------------------------------ 工具条 */
function surround(before, after) {
  const t = els.editor;
  const s = t.selectionStart, e = t.selectionEnd;
  const sel = t.value.slice(s, e);
  const text = before + (sel || "") + (after ?? before);
  t.setRangeText(text, s, e, "end");
  if (!sel) t.setSelectionRange(s + before.length, s + before.length);
  t.focus();
  dirty = true;
  render();
}

function prefixLines(prefix) {
  const t = els.editor;
  const s = t.selectionStart, e = t.selectionEnd;
  const start = t.value.lastIndexOf("\n", s - 1) + 1;
  const end = e === s ? s : e;
  const block = t.value.slice(start, end);
  const out = block.split("\n").map((l) => prefix + l).join("\n");
  t.setRangeText(out, start, end, "end");
  t.focus();
  dirty = true;
  render();
}

/* 工具条按钮统一在这里绑：data-wrap 指定包裹文本，
   data-wrap-close 可以给一个不同的收尾（例如 <strong>…</strong>）。 */
document.querySelectorAll("[data-wrap]").forEach((btn) => {
  btn.addEventListener("click", () =>
    surround(btn.dataset.wrap, btn.dataset.wrapClose ?? btn.dataset.wrap));
});

document.querySelectorAll("[data-line]").forEach((btn) => {
  btn.addEventListener("click", () => prefixLines(btn.dataset.line));
});

document.querySelector("[data-link]").addEventListener("click", () => {
  const t = els.editor;
  const sel = t.value.slice(t.selectionStart, t.selectionEnd) || "链接文字";
  surround("[", "](https://)");
  setStatus("把括号里的地址换成真实链接");
  void sel;
});

document.querySelector("[data-code]").addEventListener("click", () => {
  const t = els.editor;
  const s = t.selectionStart, e = t.selectionEnd;
  const sel = t.value.slice(s, e) || "code";
  t.setRangeText("```\n" + sel + "\n```\n", s, e, "end");
  t.focus();
  dirty = true;
  render();
});

document.querySelector("[data-hr]").addEventListener("click", () => {
  const t = els.editor;
  t.setRangeText("\n---\n", t.selectionStart, t.selectionEnd, "end");
  t.focus();
  dirty = true;
  render();
});

/* ---------------------------------------------------------------- 插图 */
async function uploadFiles(files) {
  const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
  if (!images.length) return;
  setStatus("正在处理 " + images.length + " 张图片…");

  const marks = [];
  for (const file of images) {
    try {
      const blob = await compress(file);
      const res = await api("/api/upload?name=" + encodeURIComponent(file.name), {
        method: "POST",
        headers: { "Content-Type": blob.type || "application/octet-stream" },
        body: blob,
      });
      marks.push(`![${file.name.replace(/\.[^.]+$/, "")}](${res.path})`);
      setStatus(`已保存 ${res.path}（${Math.round(res.bytes / 1024)} KB）`, "ok");
    } catch (e) {
      setStatus("上传失败：" + e.message, "error");
      return;
    }
  }

  // 光标处插入，每张图之间空一行
  const t = els.editor;
  const ins = (t.value && !t.value.endsWith("\n") ? "\n\n" : "") + marks.join("\n\n") + "\n";
  t.setRangeText(ins, t.selectionStart, t.selectionEnd, "end");
  t.focus();
  dirty = true;
  render();
}

/* 上传前在浏览器里压一下：长边超过 1600px 就等比缩小，
   再转成 WebP（不支持时退回 JPEG）。这样仓库不会被相机原图撑大。 */
async function compress(file) {
  const MAX = 1600;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file; // 解不开（例如 SVG）就原样上传

  let { width, height } = bitmap;
  const scale = Math.min(1, MAX / Math.max(width, height));
  if (scale < 1) { width = Math.round(width * scale); height = Math.round(height * scale); }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const type = file.type === "image/svg+xml" ? file.type : "image/webp";
  const blob = await new Promise((r) => canvas.toBlob(r, type, 0.86));
  if (!blob) return file;
  // 转换后反而更大就用原图
  return blob.size < file.size ? blob : file;
}

els.upload.addEventListener("click", () => els.file.click());
els.file.addEventListener("change", () => {
  uploadFiles(els.file.files);
  els.file.value = "";
});

window.addEventListener("dragover", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  els.drop.classList.add("is-on");
});
window.addEventListener("dragleave", (e) => {
  if (e.relatedTarget) return;
  els.drop.classList.remove("is-on");
});
window.addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  els.drop.classList.remove("is-on");
  uploadFiles(e.dataTransfer.files);
});

/* 截图之后直接 Ctrl+V 粘进来 */
els.editor.addEventListener("paste", (e) => {
  const files = Array.from(e.clipboardData?.files || []);
  if (files.some((f) => f.type.startsWith("image/"))) {
    e.preventDefault();
    uploadFiles(files);
  }
});

/* ---------------------------------------------------------- 会话与出口链接
   开发模式挂着 /site/ 预览（响应一律 no-store，保存完点一下就是最新的），
   生产模式没有预览，只能看真正的线上站点 —— 由服务端告诉我们当前是哪种，
   前端不猜。拿不到也不影响写作，就按 href 里写好的开发模式默认值走。 */
async function initSession() {
  try {
    const s = await api("/api/session");
    const base = s.adminBase || "";
    els.openHome.href = s.dev ? base + "/site/index.html" : "/";
    els.openBlog.href = s.dev ? base + "/site/blog/index.html" : "/blog/index.html";
    if (!s.dev) els.logout.hidden = false;
  } catch { /* 忽略：下面照常加载文章 */ }
}

/* ------------------------------------------------------------------ 绑定 */
els.save.addEventListener("click", save);
els.build.addEventListener("click", build);
els.new.addEventListener("click", createNew);
els.delete.addEventListener("click", confirmDelete);
els.logout.addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch { /* 清不掉也照样跳走 */ }
  location.replace("login");
});

window.addEventListener("beforeunload", (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = "";
});

/* ------------------------------------------------------------------ 启动 */
(async function init() {
  try {
    await initSession();
    const posts = await loadList();
    if (posts.length) await open(posts[0].slug);
    else createNew();
  } catch (e) {
    setStatus("启动失败：" + e.message + "（后台服务还在跑吗？）", "error");
  }
})();
