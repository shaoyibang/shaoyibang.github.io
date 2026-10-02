<div align="center">

# Sean 的工具库

写代码，也写下来为什么这么写。

**手写 HTML / CSS / JavaScript · 零构建 · 零依赖 · 零第三方请求 · 全站没有一张图片素材**

[**在线看看 →**](https://shaoyibang.github.io)

</div>

![首页](docs/preview.png)

<p align="center"><sub>暖调编辑风：奶油底色 + 衬线标题 + 单一珊瑚强调色。悬停时按钮长出一圈同色环，而不是变色。</sub></p>

---

## 这是什么

我是邵乙梆（Sean），在郑州写代码的初级全栈开发者。这个站点只做两件事：**写随笔、放几个小工具**。没有作品集，也没有自我介绍页——想了解我，看文章就行。

技术上它是我的练习场：**没有框架、没有构建步骤**，一边搭一边弄懂它为什么能跑。

字体的选择是有理由的：标题用衬线、正文用无衬线，而且**衬线标题比正文还轻**（字重 340 对 400）。这不是笔误——标题靠字号和衬线本身建立语气，加粗反而会变吵。

写内容的原则是**不编数字**。所以这里看不到"提升 40%""服务 5000+ 用户"这种话，因为确实还没有。

## 两个模块

| 模块 | 页面 | 里面有什么 |
| --- | --- | --- |
| **随笔** | `blog/` | 目前只有一篇测试稿。原来那三篇初稿（Bento 网格为什么这么耐看 / 做玩具是检验设计直觉最快的方式 / 先让它不用 JS 也能用）从正文撤下来了，打算用自己的话重写——原文还在 git 历史 `b5954a8` 里 |
| **工具** | `tools.html` | 三个纯 Canvas 小工具：涂鸦板（可导出 PNG）、贪吃蛇（方向键 / WASD / 触屏方向键）、生命游戏 |

首页只做一件事：把这两块按顺序铺开（随笔 → 工具 → 联系）。

## 设计语言

整套视觉是从 claude.com / anthropic.com 的**线上 CSS 令牌**反推出来的，不是照着截图估的。

| 项 | 值 | 说明 |
| --- | --- | --- |
| 页面底色 | `#faf9f5` | 暖奶油。全站不用纯白做底 |
| 卡片底色 | `#ffffff` | 比底色"抬起"一档，是层次的主要来源 |
| 正文色 | `#3d3d3a` | 最深也用 `#141413`，全站不用纯黑 |
| 次级文字 | `#5e5d59` | 说明、元信息 |
| 发丝线 | `#e8e6dc` | 1px，替代投影 |
| 强调色 | `#d97757` | clay。**全站唯一的强调色**，只给 logo 星标、文字选中、焦点环、整块色带 |
| 主按钮 | `#141413` 底 | 黑底奶油字。珊瑚色留给品牌按钮，不铺在主 CTA 上 |
| 圆角 | 按钮 8px / 卡片 16px / 面板 32px | 不是胶囊 |
| 投影 | 最重一层 ~10% alpha | 层次靠色块，不靠影子 |

字体（原版 Anthropic Serif / Sans / Mono 是自有字体，未授权再分发，所以用开源近似）：

| 用途 | 字体 | 替代谁 |
| --- | --- | --- |
| 标题衬线 | Fraunces（可变字重，按字号自动选光学尺寸） | Anthropic Serif |
| 中文衬线 | Noto Serif SC（按 unicode-range 分 101 个子集，只下载用到的那几个） | — |
| 正文无衬线 | Inter | Anthropic Sans |
| 等宽 | JetBrains Mono | Anthropic Mono |

**字体是自托管的，不走 Google Fonts。** 服务器在国内，`fonts.googleapis.com` 国内访客基本拿不到，衬线标题会掉回系统字体——而衬线标题正是这套设计语言的支点。

做法是**镜像**而不是自己切子集：把 Google 的 CSS 和它引用的 120 个 woff2 原样搬进 `assets/fonts/`，只把 URL 改成相对路径。`unicode-range` 分片照旧保留，浏览器仍然只下载页面上真正用到的那几片——**访客侧传输量一点没变**（磁盘上占 6.8 MB，但那是只落盘、不下载）。

自己用 `pyftsubset` 切子集是另一条路，但那要先收集全站字符，漏一个字就会在某篇文章里变成豆腐块——一个只在特定页面暴露的 bug。何况本机也没装 fontTools。

换字体：改 `tools/fonts.mjs` 里的 `FONTS_CSS_URL` 再重跑 `node tools/fonts.mjs`；字体族名改 `site.css` 顶部 `:root` 的 `--font-display` / `--font-sans` / `--font-mono`。

## 街上能玩的东西

- **暖调单配色** —— 一套克制的奶油 + 珊瑚。原来的四套（白天/黄昏/夜晚/复古印刷）是给手绘街区用的，跟现在的语言冲突，已移除。配色仍然是 CSS 变量，新增一套只要加一个 `[data-palette]` 块。
- **编号菜单** —— 右上角按钮或按 `M` 打开，`Esc` / 点遮罩 / 关闭按钮都能关，`Tab` 锁在弹窗里，关闭后焦点回到触发按钮。
- **左上角北京时间** —— 按 UTC+8 算，跟访客在哪个时区无关；每秒走一格，标签页切到后台就停。
- **节假日倒计时** —— 时钟右边那行，自动挑下一个法定节假日（中秋过了变国庆，国庆过了变元旦）。
- **背景音乐开关** —— 音符按钮，**默认关闭**，不点就不会下载（`preload="none"`）；换页接着放，音量 85%。
- **首页的「最近更新」列表** —— 深色面板里那 3 条，与左侧文字栏等高。**这块是构建器生成的**：把 `blog/posts/*.md` 与 `tools/build.mjs` 里的 `TOOLS` 清单合并、按日期倒序取前 3 条，所以新增随笔或工具它会自己更新。要加减工具或改工具日期，改 `TOOLS` 数组。

## 写一篇随笔

随笔的源文件是 Markdown，放在 `blog/posts/`；页面由 `tools/build.mjs` 生成。发布出去的仍然是纯静态 HTML，浏览时不跑任何转换。

**线上写（部署之后）**：浏览器打开 `https://<域名>/admin/`，登录即可。保存会连做三件事：写 Markdown 源 → 重新生成页面 → git 提交。手机上也能用。

> 后台跑在服务器上的 `server/admin.mjs`，**全站只有它需要登录**；静态页面由 Caddy 直接发文件，后台进程挂了站点照常在线上。部署与运维见 [`deploy/README.md`](deploy/README.md)。

**本地写（同一套界面，开发模式）**：

```powershell
node tools/editor.mjs
# 然后打开 http://127.0.0.1:4322
```

> 开发模式不鉴权、只绑 `127.0.0.1`、**不会自动提交**——改稿和提交分开，你审查完 diff 自己 push。
> `tools/editor.mjs` 只是薄壳，实现在 `server/admin.mjs`：写路径只有一份代码。

左边选文章、中间写、右边实时预览。工具条能加粗体、标题、列表、引用、代码块；标题、摘要、分类、文件名在同一页填。**图片直接拖进来或 Ctrl+V 粘贴**，会先在浏览器里压到长边 1600px 再转 WebP，然后存进 `assets/img/`，并把 Markdown 引用插到光标处。按 `Ctrl+S` 保存，保存时自动重新生成页面。

**想看效果**：顶栏的 **「打开主页 ↗」/「随笔列表 ↗」** 指向 `http://127.0.0.1:4322/site/…`，是同一台服务挂出来的站点预览，响应带 `no-store`。所以保存完点一下就是最新的，不用另起服务、也不用手动强刷。

> 注意：如果你习惯用别的地址看站点（比如另起的静态服务、或直接双击 HTML 文件），那边会有浏览器缓存，**加删文章后得手动刷新**才能看到。用顶栏那两个入口没这个问题。

顶栏的 **「删除这篇」** 会删掉 `blog/posts/<文件名>.md`，并连带移除页面、更新其它文章的「上一篇 / 下一篇」和随笔列表。删除前会二次确认；**新建但还没保存的文章不能删**（按钮置灰）。提交过的内容可以从 git 历史里找回。

![写作工具](docs/preview-editor.png)

> 本地这个实例只监听 `127.0.0.1`，外部访问不到。线上那份是**同一个文件**的生产模式：强制登录、绑容器内网卡、由 Caddy 反代进来，并且 `/site/` 预览整个关掉——那个路由会把仓库连同 `.git` 一起挂出去。

**或者纯手工**：新建 `blog/posts/我的文章.md`，写好头部再跑生成器。

````markdown
---
title: 文章标题
date: 2026-09-30
summary: 一句话摘要（列表页显示，也用作 meta description）
lede: 正文开头那段导语
cats: 布局 / CSS Grid
slug: my-post
---

正文从这里开始。支持 ## 标题、**粗体**、`行内代码`、- 列表、> 引用，以及三反引号围起来的代码块。
图片写 ![说明](../assets/img/xxx.webp)。
````

几个容易踩的约定：

- **`slug` 必须和文件名一致**，它决定网址 `blog/<slug>.html`。
- **正文标题从 `##` 写起**。页面自身的文章标题已经是 `<h1>`，而每页只能有一个 —— 生成器会把正文标题整体降级，所以你写 `#` 也会渲染成 `<h2>`。
- 图片路径是**相对文章页**算的，所以要写 `../assets/img/…`。
- 阅读时长不写就按字数估算；想固定就在 front matter 里加 `minutes`。

```powershell
node tools/build.mjs          # 手动重新生成
node tools/build.mjs --check  # 只检查生成物是否与源同步（不写文件）
```

**生成器会写这些文件**：

| 文件 | 内容 |
| --- | --- |
| `blog/<slug>.html` | 每篇文章页 |
| `blog/index.html` | 随笔列表 |
| `index.html` | **只更新两处**：`<!-- journal:start/end -->` 之间的随笔列表，和 `<!-- stat:posts -->` 里的篇数 |
| 删除 | `blog/` 下没有对应 `.md` 的 `.html` 会被清掉，避免留下死页面 |

首页其余部分仍是手写的，生成时只替换上面那两处标记。文章一篇都没有时，首页那块会显示「还没有写过随笔」。

## 本地跑起来

```powershell
# 方式一：直接双击（相对路径都是按这个场景写的，能正常打开）
start index.html

# 方式二：起个本地服务（和线下的路径与相对链接行为完全一致）
npx --yes serve . -l 4321

# 方式三：不用额外装东西，顺带把写作界面和站点预览一起挂出来
node tools/editor.mjs        # 写作界面 http://127.0.0.1:4322
                             # 站点预览 http://127.0.0.1:4322/site/index.html
```

> 预览的响应带 `no-store`，所以**保存完点一下就是最新的**，不用另起服务、也不用手动强刷。
> 如果你习惯用别的地址看站点（另起的静态服务、或直接双击 HTML），那边有浏览器缓存，
> 加删文章后得手动刷新才能看到。

改完东西跑一下自检：

```powershell
node tools/check.mjs          # 页面向外引用是否完整、有没有断链、有没有外链子资源
node tools/md.test.mjs        # Markdown 转换器（含各种转义边界）
node tools/home.test.mjs      # 首页的随笔列表/篇数是否与 blog/posts/ 一致
node tools/fonts.mjs --check  # 字体分片齐不齐（不联网）
node tools/build.mjs --check  # 生成物是否与 Markdown 源同步（不写文件）
```

后台和部署那部分：

```powershell
node server/admin.test.mjs    # 口令 / 会话 / 限流 / 路径穿越 / 上传 + 全部路由 + 保存往返
node server/login.test.mjs    # 生产模式：缺配置拒绝启动、401/302、锁定与解封、cookie 属性
node deploy/scripts.test.mjs  # .env 取值、systemd 模板、备份（需要 bash）
node deploy/caddyfile.test.mjs# 真起一个 Caddy 验公开面（需要 caddy 或 CADDY_BIN）
```

需要浏览器调试端口的（可选，见 `tools/shots.mjs` 的说明）：

```powershell
node server/web.test.mjs      # 写作界面：模块加载、相对接口、字体、零报错
node tools/verify.mjs         # 站点端到端：设计令牌、交互、零第三方请求
```

`tools/check.mjs`、`home.test.mjs`、`build.mjs --check` 这三条是"防回归"用的，对应真实踩过的坑：删了文章首页还列着旧链接、生成物和源悄悄不同步、以及字体被换回外链。CI 里跑的就是上面这些（`.github/workflows/ci.yml`），**不需要 `npm install`**——没有 `package.json`。

## 部署

目标是跑在自己的服务器上（国内、已备案的 2 核 2G）。**部署脚本已经就绪，但需要你在服务器上跑一次**——照着 [`deploy/README.md`](deploy/README.md) 走即可。目标形态：

```
Internet :443
   ├── /            → Caddy 直接读磁盘上的静态文件（不经 Node）
   ├── /admin/*     → 反代到 admin 容器（写作后台，需要登录）
   └── 其它         → 404
```

两个容器：Caddy 发静态文件，admin 提供写作后台。常驻内存合计约 200 MB。

**静态页面跟 Node 无关**，这是故意的：后台崩了、重启了、被 OOM 杀了，站点照常在线上。

部署和运维的完整步骤在 [`deploy/README.md`](deploy/README.md)（含上线验收清单、备份恢复演练、故障排查表）。日常两条命令：

```bash
git push                          # 本机改完代码
ssh 服务器 'cd /srv/site && bash deploy/deploy.sh'   # 服务器上更新
```

写文章不用碰命令行——浏览器打开 `https://<域名>/admin/` 就行。

> **相对 GitHub Pages 的主要收益**：Pages 是把仓库根目录整个公开出去的，`blog/posts/*.md`、
> `tools/*.mjs`、`README.md`、`.git` 都能直接下载。自有服务器上公开面是一张**允许列表**，
> 那些路径全是 404。这一条由 `deploy/caddyfile.test.mjs` 守着。
>
> 另外国内访问自有备案域名比访问 GitHub Pages 稳得多。

GitHub 仍然是代码的源头和 CI（`.github/workflows/ci.yml`），服务器每 10 分钟和它同步一次。

## 目录结构

```
.
├─ index.html                首页：hero + 随笔 / 工具 / 联系
├─ tools.html                工具（三个 Canvas 小玩意）
├─ robots.txt                Disallow /admin 和 /api
├─ blog/
│  ├─ posts/*.md             随笔源文件（Markdown + front matter）—— 改内容改这里
│  ├─ index.html             随笔列表（生成）
│  └─ *.html                 每篇文章页（生成）
├─ assets/
│  ├─ css/site.css           唯一的样式表：设计令牌 + 全部组件
│  ├─ fonts/                 自托管字体：fonts.css（生成）+ 按内容哈希命名的 woff2
│  ├─ img/                   随笔里插入的图片（后台/编辑器上传到这里）
│  ├─ js/site.js             全站交互：菜单 / 时钟 / 倒计时 / 音乐 / 入场
│  └─ js/tools.js            三个 Canvas 小工具
├─ server/                   写作后台（唯一实现，开发/生产两种模式）
│  ├─ admin.mjs              路由 + 模式开关（--dev / 生产）
│  ├─ auth.mjs               scrypt 口令、HMAC 会话、登录限流、真实 IP
│  ├─ paths.mjs              路径边界、图片文件头识别、静态解析
│  ├─ *.test.mjs             后台的单元与路由测试
│  └─ web/                   写作界面：index.html / login.html / app.js / editor.css
├─ deploy/                   部署与运维
│  ├─ Dockerfile.admin       admin 的镜像（只装 Node + git，代码靠挂载）
│  ├─ docker-compose.yml     两个容器、挂载、内存上限、日志轮转
│  ├─ Caddyfile              HTTPS / 静态托管 / 反代 / 公开面允许列表 / 缓存头
│  ├─ .env.example           配置模板（复制成 .env 再填，.env 不进仓库）
│  ├─ bootstrap.sh           一次性服务器准备
│  ├─ deploy.sh              部署 / 更新
│  ├─ backup.sh / sync.sh    备份 / 与 GitHub 同步
│  ├─ systemd/*.in           定时器单元模板
│  ├─ lib.sh                 脚本共用函数（被测试覆盖）
│  └─ README.md              运维手册
├─ .github/workflows/ci.yml  CI：自检 + 后台测试 + 部署脚本 + Caddyfile
├─ docs/preview*.png         README 里的预览图
├─ music.mp3                 背景音乐（128kbps CBR / 44.1kHz / 2 分 56 秒）
├─ tools/
│  ├─ editor.mjs             本地写作服务入口（薄壳，开发模式）
│  ├─ fonts.mjs              从 Google 抓字体分片镜像到 assets/fonts/（唯一联网的脚本）
│  ├─ passwd.mjs             生成后台口令哈希与会话密钥
│  ├─ md.mjs                 Markdown → HTML 转换器（编辑器与生成器共用）
│  ├─ md.test.mjs            转换器的单元测试
│  ├─ build.mjs              从 blog/posts/*.md 生成页面
│  ├─ check.mjs              自检：断链 / 结构 / 外链子资源
│  ├─ shots.mjs              抓 README 预览图（可选）
│  └─ verify.mjs             端到端验收（可选）
└─ README.md
```

> `blog/posts/*.md` 是**源**，`blog/*.html` 是**产物**。改内容只动 Markdown，再跑 `node tools/build.mjs`。
>
> 注意别搞混：**`tools/` 是放脚本的目录，`tools.html` 是「工具」那个页面**，两个东西。

## 想改哪里

| 想改什么 | 改哪里 |
| --- | --- |
| 全站配色 | `site.css` 顶部 `:root` —— 改一处，全站跟着变 |
| 字体 | 换字体文件：改 `tools/fonts.mjs` 的 `FONTS_CSS_URL`，再跑 `node tools/fonts.mjs`；换字体族名：`site.css` 的 `--font-display` / `--font-sans` / `--font-mono` |
| 后台登录口令 | `node tools/passwd.mjs --out deploy/.env`，然后 `docker compose up -d --force-recreate admin` |
| 公开面（哪些路径能被访问） | `deploy/Caddyfile` 里 `@public` 那张允许列表。**改完一定要跑 `caddy validate`**，语法错等于全站 502 |
| 部署参数（域名、内存上限） | `deploy/.env` 与 `deploy/docker-compose.yml` |
| 按钮圆角、悬停效果 | `site.css` 的 `.btn` 系列。**悬停是加一圈同色环，不是改底色** |
| 首页 hero 文案 | `index.html` 的 `.hero__title` |
| 首页「最近更新」 | 生成物，**不要手改** `index.html` 里 `<!-- updates:start -->` 与 `<!-- updates:end -->` 之间的内容；要调内容就改 `tools/build.mjs` 的 `TOOLS`（工具日期）或写新随笔 |
| 菜单项 | `site.js` 与各页 `.menu__list` 里的 `li`：编号 / 中文名 / 英文名 |
| 左上角时钟 / 倒计时 | `site.js` 的 `clock()` 与 `countdown()`，节假日表是里面那个 `HOLIDAYS`（一年一行，官方调休公布后改对应那行；表用完了会自动退回"明年元旦"） |
| 背景音乐 | 换文件就改 7 个页面的 `<audio id="bgm" src=…>`（`blog/` 下要写 `../`）；音量是 `site.js` 里的 `VOLUME` |
| 浏览器标签页图标 | 每个 HTML `<head>` 里的 `rel="icon"`，是一段 URL 编码的 SVG data URI（S 字标）；文章页还要同步 `tools/build.mjs` 里的 `FAVICON` 常量 |
| 页头字标 | 各页 `.brand__mark`（内联 S 字标）；文章页还要同步 `tools/build.mjs` 里的 `BRAND_MARK` |
| 页面底部导航 / 页脚 | 各页 `.footer` |

## 技术选择

- **零构建零依赖**：连字体都在自己域名下，**全站没有任何第三方请求**；外链被墙也不会掉样式。整站没有 `package.json`。
- **设计令牌**：所有颜色、圆角、投影、缓动都是 CSS 变量。深色面板和奶油页面共用同一套令牌，只是取不同的变量。
- **中文衬线按需下载**：`Noto Serif SC` 用 `unicode-range` 分成 101 个子集，浏览器只抓页面上真正出现的那几个字所在的切片，不会整包下载。自托管之后这个行为没变——只是来源从 Google 换成了自己的 `assets/fonts/`。
- **静态优先**：页面在构建时生成成纯 HTML，线上不跑模板渲染；后台进程崩了站点也照常在。
- **零图片素材**：图标、头像、热力图、抽象面板全部是内联 SVG 或 CSS。
- **可访问性**：跳转链接、可见焦点环、图标按钮都有可访问名称、`role="dialog"` + 焦点陷阱与关闭后恢复、全程尊重 `prefers-reduced-motion`。
- **尺寸按字符算**：正文宽度用 `ch`（72ch），不写死 px，字号变了阅读宽度还合适。

## 踩过的坑（都修好了，改的时候别改回去）

1. **别让内容默认藏在 CSS 里**。`.reveal` 的隐藏态写在 `html.js` 下，而且脚本会先把"已经在视口内"的元素无条件显示出来，再交给 `IntersectionObserver`。只靠 observer 回调的话，一旦它没触发，首屏卡片会永远停在 `opacity: 0` —— 这个是实测踩到的，不是假设。
2. **衬线标题不要加粗**。这套语言的字重是反向的：标题 340，正文 400。加粗到 600/700 立刻变成另一种气质。
3. **悬停要"变厚"，不要"变色"**。主按钮悬停是长出一圈 `box-shadow: 0 0 0 2px` 的同色环；改成变深色就不像了。
4. **珊瑚色要省着用**。只给 logo 星标、文字选中、焦点环、整块色带和品牌按钮。主 CTA 是黑底。
5. **算北京时间别掺 `getTimezoneOffset()`**。时间戳直接 `+8h` 再用 `getUTC*` 读就是北京墙上时间；再减一次本机偏移得到的是 UTC —— 而本机正好在 UTC+8 时它"看着像对的"，差 8 小时还不容易被发现。
6. **`.toy__stage` 里的画布用绝对定位**。外层按 `width/height` 属性算出的比例撑开，画布 `inset: 0` 填满，再加一道 `max-height`，否则宽屏下一块画布能占满整屏。
7. **`em` 对中文标题会窄得离谱**。`max-width: 22em` 在拉丁字体下约等于 22 个字符宽，但 1em 只有半个汉字宽，中文标题会被挤成三行、末字单独掉一行。首页 hero 的 `max-width: 520px` 是按实测值定的（「做成能跑的东西」在 52px 下需要约 363px）。
8. **站名散在多个页面里，改的时候要一起改**。具体是每页的 `<title>`、页头的 `.brand` 字标、页脚署名，以及 `.menu__copy` 版权行；随笔页还有 `tools/build.mjs` 里的页面外壳（不改它，重新生成就会把旧站名写回来）。
9. **Markdown 里有两套"看起来一样"的代码写法，语义不同**。`` `a < b` `` 里写的是源码，会被转义；`<code>&lt;a&gt;</code>` 里写的是最终 HTML，原样保留。这两种刻意**没有**归一化 —— 强行统一必然有一边失真。同理，正文里可以直接写裸标签（`<a>`、`<strong>`、`<br>`），这是逃生口。
10. **`<pre>` 里的缩进是内容**。给生成结果统一缩进时（`indentBody`）必须跳过代码块内部的行，否则读者看到的代码会多出一层空格。
11. **删文章必须连页面一起收走**。生成器只写不删的话，删掉一篇随笔会在 `blog/` 留下一个孤儿 HTML —— 它不在列表里、没人访问得到，但会被部署上线。所以 `buildAll` 里加了孤儿清理：`blog/<slug>.html` 只要没有对应的 `blog/posts/<slug>.md` 就删掉。**不是**生成物的 HTML 不要往 `blog/` 放。
12. **首页上凡是"文章状态的投影"，都不要手写**。首页原先手写了随笔列表和篇数，结果删完三篇文章后，首页还列着那三篇已经不存在的文章，链接全断——自检才报出来。现在这两块由生成器按标记替换（`journal:start/end`、`stat:posts`）。**加新的这类区块时，同样走标记 + 生成，别手写。**
13. **字体不要外链 Google**。服务器在国内，`fonts.googleapis.com` 基本拿不到，衬线标题会掉回系统字体——整套设计语言的支点就没了。现在镜像到 `assets/fonts/`，并且 `check.mjs` 会**让任何外链子资源直接失败**（`<a href>` 不算，菜单里的 GitHub / X / B 站是要留的）。
14. **绝对不要 `source deploy/.env`**。口令哈希是 `scrypt$32768$8$1$<salt>$<key>`，shell 会把 `$32768` 展开成 `$3` 加 `"2768"`，哈希被悄悄改坏——表现是**部署一路绿灯，但密码怎么都登不进去**。`deploy/lib.sh` 里的 `envval` 只做文本取值，一个字都不交给 shell；`deploy/scripts.test.mjs` 里有一条对照测试专门盯着这个。
15. **`envval` 要去掉值尾的空白和 `\r`**。`SITE_DOMAIN=example.com ` 多一个空格，ACME 就签不下证书，而报错信息完全指不到 `.env` 这一行。在 Windows 上编辑过 `.env` 很容易带上 `\r`，同样不可见。
16. **反向代理剥掉前缀之后，前端的接口和模块路径必须写相对的**。后台在开发模式挂在 `/`、生产模式挂在 `/admin/` 下（Caddy 用 `handle_path` 把 `/admin` 剥掉再转发），所以 `/api/posts` 这种绝对路径在生产模式会打到主站上去，而那边没有这个接口。`app.js` 里所有调用都经一个 `apiUrl()` 转成相对路径，模块导入写成 `./md.mjs`。
17. **静态资源解析不要做 basename 兜底**。"取结尾文件名再看目录里有没有"这种写法会让地址空间变得不可预测：`/site/index.html` 会安静地返回后台首页而不是 404，`/随便什么/app.js` 也拿得到 `app.js`。现在只认一张显式路径表。
18. **没有内容指纹的静态资源不能 `immutable`**。`site.css` / `site.js` 的文件名里没有哈希，给它们长缓存会让改版之后的访客一直看到旧样式。所以 HTML 是 `no-cache`、这两个是 `max-age=3600`；图片和字体分片是**内容哈希命名**的，才可以 `immutable`。
19. **容器里的 git 需要身份和属主**。不给 `GIT_AUTHOR_*` / `GIT_COMMITTER_*`，`git commit` 直接报 "Please tell me who you are"；容器用户和挂载目录属主不一致则报 "dubious ownership"。`docker-compose.yml` 里这两组都预置了。
20. **容器日志必须轮转**。json-file 驱动默认无限增长，一台 2G 的机器被 access log 撑满磁盘是很常见的翻车方式。compose 里设了 `max-size 10m / max-file 3`，Caddy 的访问日志也自带 `roll_size`。
21. **"把仓库挂出去"的预览功能只能存在于开发模式**。`/site/` 会把整个仓库（含 `.git`、文章源文件）挂到 `adminBase + /site/` 下，而反代恰好会把 `adminBase` 剥掉——于是 `/admin/site/` 就等于把仓库连同历史一起公开。生产的那个模式里这个路由整个不存在。
22. **容器里别忘设时区**。不设 `TZ=Asia/Shanghai`，后台按 UTC 算日期，新建文章的 `date` 可能差一天。

## 还在路上

- 那三篇初稿（Bento 网格 / 做玩具 / 不用 JS 也能用）想用自己的话重写一遍再放回来，原文在 git 历史 `b5954a8` 里。
- 想补 RSS / sitemap，以及一张 1200×630 的分享封面图。
- 文章多了以后加站内搜索。倾向 Pagefind 那种纯静态索引，不想为了搜索引一个常驻服务。
- `docs/preview.png` 是改版前的截图，还没重拍。

---

代码随便参考；插画和文字是邵乙梆的。
