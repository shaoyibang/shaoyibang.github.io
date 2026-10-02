# 部署与运维手册

这个目录里的东西负责把站点跑在自有服务器上。目标形态是：

```
Internet :443
   │
   ├── /            → Caddy 直接读磁盘上的静态文件（不经 Node，快、可缓存）
   ├── /admin/*     → 反代到 admin 容器（写作后台，需要登录）
   └── 其它         → 404（允许列表之外一律不给）
```

两个容器，常驻内存合计约 200 MB，2 核 2G 的机器余量很大。

**静态页面由 Caddy 提供、跟 Node 无关**，这一点是故意的：后台进程崩了、
重启了、被 OOM 杀了，站点照常在线上。

---

## 目录里都有什么

| 文件 | 作用 |
| --- | --- |
| `Dockerfile.admin` | 后台的运行镜像。不含代码（代码靠挂载），只装 Node + git |
| `docker-compose.yml` | 两个容器、挂载、内存上限、日志轮转 |
| `Caddyfile` | HTTPS、静态托管、反代、公开面允许列表、缓存头 |
| `.env.example` | 配置模板。复制成 `.env` 再填，**`.env` 不进仓库** |
| `lib.sh` | 脚本共用的小函数（`.env` 取值、彩色输出），被测试直接覆盖 |
| `bootstrap.sh` | 一次性服务器准备：装依赖、加 swap、建目录、装定时器 |
| `preflight.sh` | 上线前体检：系统 / 资源 / 端口 / 防火墙 / DNS / 镜像能否拉取 / 凭据是否就位 |
| `deploy.sh` | 部署 / 更新（幂等，可反复跑） |
| `backup.sh` | 打一个归档到 `/var/backups/site` |
| `sync.sh` | 与 GitHub 双向同步，由定时器每 10 分钟跑 |
| `systemd/*.in` | 定时器单元模板，`bootstrap.sh` 会把占位符替换掉再安装 |
| `caddyfile.test.mjs` | 真起一个 Caddy，验公开面和缓存头 |
| `scripts.test.mjs` | 验 `.env` 取值、模板替换、备份 |

---

## 一、前置条件

1. **服务器**：Linux（Ubuntu 22.04+ / Debian 12 为准），2 核 2G 起，≥20 GB 磁盘，有 root。
2. **域名**：**已备案**（服务器在国内大陆的话，没备案 80/443 会被拦），并已解析到本机公网 IP。
3. **安全组 / 防火墙**：放行 **80** 和 **443**。80 不能省 —— 证书签发要用它做 HTTP-01 校验。
4. **一个能 SSH 登录的账号**（`bootstrap.sh` 会把它加进 `docker` 组，加完要重新登录）。

**服务器上需要预装什么？什么都不需要。** 一台全新、什么都没装的机器就能开始：
`bootstrap.sh` 会装 git、Docker、compose、openssh-client，加 2G swap，建目录，装定时器。

> **宿主机上不需要 Node。** 后台的 Node 跑在容器里；宿主机只用得到 git、docker、
> bash、tar 这些。唯一需要 Node 的一步（生成口令哈希）在**你自己的机器**上做完，
> 再连同仓库一起拷过去。这是刻意的：为了跑一次哈希就在干净服务器上装一个
> Node 运行时，不值当，也多了个要跟着升版本的东西。

---

## 二、一次性安装

下面这个顺序不是随便排的，它绕开了三个"先有鸡还是先有蛋"：

| 干净服务器上没有 | 所以不能 | 改成 |
| --- | --- | --- |
| **git** | `git clone` 取代码 | 从你本机 `scp` 拷过去 |
| **Node** | 在服务器上生成口令哈希 | 在本机生成好，随仓库一起拷 |
| **能访问 GitHub 的密钥** | 直接推送 | 先 `bootstrap.sh` 生成 Deploy key，你加到 GitHub |

### 1. 在你自己的机器上准备好配置

在**本机**的仓库目录里（这一步用本机的 Node）：

```powershell
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env，先只填这两个：
#   SITE_DOMAIN=你的域名
#   ACME_EMAIL=你的邮箱
node tools/passwd.mjs --out deploy/.env
```

`passwd.mjs` 会交互式地问两遍口令（不回显），把 `ADMIN_USER` /
`ADMIN_PASSWORD_HASH` / `SESSION_SECRET` 三行写进 `deploy/.env`。

`SITE_ROOT` / `SITE_UID` / `SITE_GID` 先留着 —— 那三个要到了服务器上才知道。
`deploy/.env` 已经在 `.gitignore` 里，不会被提交。

> 口令至少 10 位。这个后台是开在公网上的，短口令等于没有。

### 2. 把仓库拷到服务器

**这里不要用 `git clone`**：那台机器上还没有 git，国内到 `github.com:443` 大概率
也不通。先拷过去，同步的事后面交给定时器。

```bash
# 先在服务器上建好目录（用你的登录账号）
ssh 用户名@服务器IP 'sudo mkdir -p /srv && sudo chown $USER:$USER /srv'
```

```powershell
# 在 Windows 本机执行（系统自带 OpenSSH 就有 scp）
cd D:\workplace\dsh\personal-web
scp -r . 用户名@服务器IP:/srv/site
```

**连 `.git` 一起拷过去** —— 提交历史要保住，服务器上的自动提交和同步都靠它。

> 这些文件在仓库里就是 LF（`.gitattributes` 里 `* text=auto eol=lf`），
> `scp` 逐字节复制不会改。如果中间经过了别的传输方式（压缩解压、某些编辑器），
> 到服务器上跑一下 `bash -n deploy/*.sh` 确认没被改坏 —— CRLF 的 shell 脚本
> 在 Linux 上会以一个很难懂的报错失败。

### 3. 在服务器上补完配置

```bash
cd /srv/site
sed -i "s|^SITE_ROOT=.*|SITE_ROOT=/srv/site|; \
        s|^SITE_UID=.*|SITE_UID=$(id -u)|; \
        s|^SITE_GID=.*|SITE_GID=$(id -g)|" deploy/.env
grep -E '^SITE_(ROOT|UID|GID)=' deploy/.env    # 确认一下
chmod 600 deploy/.env
```

### 4. 跑准备脚本

```bash
sudo bash deploy/bootstrap.sh
```

它会装 git / Docker / compose / openssh-client，加 2G swap，把 `/srv/site` 属主
调成 `SITE_UID:SITE_GID`，安装两个 systemd 定时器，检查 GitHub 连通性，
**并且如果这台机器上还没有 SSH 密钥就生成一对**，然后把公钥打印出来。

> **需要你手动做一件事**：把打印出来的那个公钥加到
> GitHub → 仓库 → Settings → **Deploy keys** → Add deploy key，
> 并**勾上 Allow write access**（不勾就只能拉、不能推）。
>
> 为什么用 Deploy key 而不是把你本机的个人私钥拷上来：前者的权限只限这一个
> 仓库，服务器万一出事，损失可控。密钥是无口令的 —— 必须如此，systemd 定时器
> 在无人值守时推送，没有地方输口令。
>
> 加完验证：`sudo -u "#$(id -u)" ssh -T git@github.com`（应该看到欢迎语）

> **不想让它自动改系统？** 这一步可以完全手工做，照下面来，然后跳到第 5 步体检：
>
> ```bash
> sudo apt-get update && sudo apt-get install -y git docker.io docker-compose-v2 openssh-client
> sudo usermod -aG docker "$USER"      # 之后重新登录
> # 2G 内存建议加 swap
> sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
> sudo mkswap /swapfile && sudo swapon /swapfile
> echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
> echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-sean-site.conf
> # Deploy key（无口令，必须如此：定时器无人值守，输不了口令）
> ssh-keygen -t ed25519 -N "" -C "site-sync@$(hostname)"
> cat ~/.ssh/id_ed25519.pub       # 加到 GitHub 的 Deploy keys，勾 Allow write access
> # github.com:443 国内常被阻断，改道 SSH over 443
> printf '\nHost github.com\n  HostName ssh.github.com\n  Port 443\n  User git\n' >> ~/.ssh/config
> chmod 600 ~/.ssh/config
> # 定时器（把占位符换成真实值）
> sed -e 's|@SITE_ROOT@|/srv/site|g' -e 's|@SITE_UID@|'"$(id -u)"'|g' \
>     -e 's|@SITE_GID@|'"$(id -g)"'|g' -e 's|@BACKUP_DIR@|/var/backups/site|g' \
>     -e 's|@BACKUP_KEEP_DAYS@|14|g' deploy/systemd/*.in
> # 逐个写进 /etc/systemd/system/ 然后 systemctl daemon-reload && systemctl enable --now site-sync.timer site-backup.timer
> ```

### 5. 上线前体检

```bash
bash deploy/preflight.sh
```

只读检查，不改系统（唯一会动的是 `docker pull`，约 200 MB；不想下载加 `--skip-pull`）。
它逐项查：系统与架构、内存/swap/磁盘、系统时间、80/443 是否被占、本机防火墙、
SELinux、Docker 与 compose、**镜像能不能从你的网络拉下来**、GitHub 连通性、
域名是否解析到本机公网 IP、仓库属主与凭据是否就位。

**为什么值得先跑**：下面这些失败原因的报错信息都不会指向真正的原因——

| 看到的报错 | 真正的原因 |
|---|---|
| 证书签不下来 | 域名没解析过来 / 没备案 / 系统时间没同步 |
| 容器起不来 | 80 被别的进程占了 |
| 后台能存文章，但宿主 `git status` 一片红 | `SITE_UID` 填错一位 |
| `docker pull` 超时 | Docker Hub 从国内不可达，要配镜像加速器 |
| 登录永远说口令不对 | `.env` 被 `source` 过，哈希里的 `$` 被 shell 展开了 |

输出里 `✓` 是通过、`!` 是警告（多数可以带着走）、`✗` 是阻塞项。
有 `✗` 就先把它们解决掉再往下走。

### 6. 首次上线

```bash
bash deploy/deploy.sh
```

流程是：拉代码 → 校验 compose 和 Caddyfile → 构建启动 → 等健康检查。
第一次会自动签发证书，通常十几秒。

---

## 三、上线验收清单

逐条过一遍，**每条都要看到预期结果**：

```bash
D=你的域名

# 1. 证书签下来了，且 HTTP 会跳到 HTTPS
curl -sI "https://$D/" | head -1                 # 期待 200
curl -sI "http://$D/"  | grep -i '^location'     # 期待 https://...

# 2. 静态页面都在
for p in / /tools.html /blog/ /blog/index.html; do
  printf '%s -> %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "https://$D$p")"
done

# 3. 【最要紧的一条】仓库源码拿不到 —— 这是自有服务器相对 GitHub Pages 的主要收益
for p in /blog/posts/ /tools/build.mjs /server/admin.mjs /deploy/.env /.git/config /README.md; do
  printf '%s -> %s (必须 404)\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "https://$D$p")"
done

# 4. 缓存头分开了
curl -sI "https://$D/" | grep -i cache-control                      # no-cache
curl -sI "https://$D/assets/css/site.css" | grep -i cache-control   # max-age=3600
curl -sI "https://$D/assets/fonts/fonts.css" | grep -i cache-control # immutable

# 5. 后台（注意接口在 /admin/api/ 下，不是 /api/ —— 后者不在允许列表里）
curl -s -o /dev/null -w '%{http_code}\n' "https://$D/admin"            # 308（补斜杠）
curl -s -o /dev/null -w '%{http_code}\n' "https://$D/admin/"           # 302（跳登录页）
curl -s -o /dev/null -w '%{http_code}\n' "https://$D/admin/login"      # 200
curl -s -o /dev/null -w '%{http_code}\n' "https://$D/admin/api/posts"  # 401（没登录）
curl -s -o /dev/null -w '%{http_code}\n' "https://$D/api/posts"        # 404（不在允许列表里）

# 6. 字体是本地的（页面上不该出现 fonts.googleapis.com）
curl -s "https://$D/" | grep -c 'fonts\.googleapis'                 # 0
```

上面这些是**能自动验的部分**。下面几条只有真机能验，`deploy/stack.test.mjs`
覆盖不到（它跑的是"真 Caddy + 真 Node"，没有容器）：

```bash
cd /srv/site/deploy

# 7. 两个容器都起来了，admin 是 healthy（healthcheck 走容器内回环）
docker compose ps
#    期待：caddy running / admin running (healthy)

# 8. 镜像拉下来了（国内网络这一步最容易卡住；拉不动就配镜像加速器）
docker images | grep -E 'caddy|node'

# 9. 属主映射对了 —— 这一条错了不会报错，只会让宿主上的 git 认不出仓库
ls -l /srv/site/blog/posts/ | head -3      # 属主应是 SITE_UID，不是 root
cd /srv/site && git status --short         # 应是干净的，且不报 dubious ownership

# 10. 重启后能自己回来
sudo systemctl restart docker && sleep 20 && docker compose ps
```

最后在浏览器里打开 `https://$D/admin/`，登录，**真的写一篇测试文章**，
确认线上 1 秒内可见、`git log` 里出现了自动提交（作者是 `.env` 里配的那个），
最后删掉它。

---

## 四、日常操作

### 写文章

浏览器打开 `https://<域名>/admin/`，登录即可。左边选文章、中间写、右边实时预览。
保存会连做三件事：写 Markdown 源 → 重新生成页面 → git 提交。

> 手机上也能用，界面是自适应到 820px 的。

**本地写也可以**（命令行习惯不变）：

```bash
node tools/editor.mjs        # http://127.0.0.1:4322，只监听回环
```

本地模式**不会**自动提交 —— 改稿和提交分开，你审查完 diff 自己 push。

### 更新代码

```bash
cd /srv/site && bash deploy/deploy.sh
```

### 看日志

```bash
cd /srv/site/deploy
docker compose logs -f admin caddy          # 实时
docker compose logs --tail 100 admin        # 最近 100 行
docker compose exec caddy tail -f /var/log/caddy/access.log   # 访问日志（带轮转）
journalctl -u site-sync -n 50               # 同步记录
```

### 重启 / 停服

```bash
cd /srv/site/deploy
docker compose restart admin     # 只重启后台，站点不受影响
docker compose up -d             # 应用配置改动
docker compose down              # 全停（站点也会下线）
```

### 改配置

改 `deploy/.env` 之后要重建容器才会生效：

```bash
cd /srv/site/deploy && docker compose up -d --force-recreate admin
```

改 `Caddyfile` 之后：

```bash
cd /srv/site/deploy
docker compose run --rm --no-deps --entrypoint caddy caddy validate --config /etc/caddy/Caddyfile
docker compose restart caddy
```

**改完 `Caddyfile` 一定要跑 `validate`**，否则语法错会让 Caddy 起不来 ——
而 Caddy 起不来意味着全站 502。

### 换口令

```bash
cd /srv/site && node tools/passwd.mjs --out deploy/.env
cd deploy && docker compose up -d --force-recreate admin
```

换 `SESSION_SECRET` 会让所有已登录的会话立刻失效，需要重新登录 —— 这是预期行为。

---

## 五、备份与恢复

### 自动备份

`site-backup.timer` 每天 04:00 跑一次，归档落在 `/var/backups/site/site-<日期>.tar.gz`，
默认保留 14 天。内含仓库全部内容（除 `.git`）**以及 `deploy/.env`**。

> ⚠️ 归档里有会话密钥和口令哈希，**等于凭据**。权限是 600、目录是 700，
> 别把它同步到网盘或者公开的存储桶里。
>
> `.git` 不进归档（那部分由 GitHub 兜着）。想把历史也备走：
> `git bundle create /var/backups/site/repo-$(date +%F).bundle --all`

手工跑一次 / 查看：

```bash
sudo systemctl start site-backup.service
sudo ls -lh /var/backups/site
```

### 恢复演练（**部署完请真的做一次**）

没演练过的备份不算备份。照下面走一遍，用最近的那个归档：

```bash
cd /srv/site/deploy
sudo docker compose down

# 归档里存的是相对路径（./index.html 这种），所以就地解包
sudo tar -xzf /var/backups/site/site-$(date +%F).tar.gz -C /srv/site
sudo chown -R "$(id -u):$(id -g)" /srv/site

# 重新生成一遍，确认源和产物一致（这一步会自己报错，如果不一致）
cd /srv/site && node tools/build.mjs --check

cd deploy && sudo docker compose up -d
```

然后照「上线验收清单」再走一遍。确认无误后，把测试文章之类的残留清掉。

### 恢复到另一台机器

1. 新机器上装好 Docker，克隆仓库（或用归档解包出目录）。
2. 把归档里的 `deploy/.env` 放回去，`chmod 600`。
3. 跑 `sudo bash deploy/bootstrap.sh`，再 `bash deploy/deploy.sh`。
4. 把域名解析指过来即可（证书会自动重新签发）。

---

## 六、GitHub 同步与「不通怎么办」

服务器和 GitHub 之间每 10 分钟同步一次（`site-sync.timer`）：

- **上行**：后台在服务器上写的文章会被推回 GitHub
- **下行**：你在别处改的代码会被拉回服务器

用 `rebase` 而不是 `merge`，历史保持线性。同步失败会以非零码退出，
`systemctl status site-sync.service` 里看得到 —— 这是故意的：推不上去必须让人知道，
否则「我明明在服务器上写过文章，GitHub 上却没有」这种问题会一直藏着。

```bash
sudo systemctl start site-sync.service      # 马上同步一次
systemctl list-timers site-sync.timer       # 下次什么时候跑
systemctl status site-sync.service          # 上次跑成没成
```

### 为什么可能需要 `ssh.github.com:443`

国内不少网络会阻断 `github.com:443`（HTTPS），但 `ssh.github.com:443` 是通的。
`bootstrap.sh` 会检测并在 `~/.ssh/config` 里加这一段（加之前会备份原文件）：

```
Host github.com
  HostName ssh.github.com
  Port 443
  User git
```

验证：

```bash
ssh -T git@github.com     # 期待：Hi shaoyibang! You've successfully authenticated...
```

### 实在连不上 GitHub

服务器上的内容仍然会**本地提交**（历史不会丢），只是推不出去。三条退路，按推荐顺序：

1. **换国内可达的镜像仓库做中转**（推荐）：在 Gitee 或阿里云 Codeup 建一个私有仓库，
   在服务器上加一个 remote 推过去，本机再从那边拉。
   ```bash
   git remote add mirror git@gitee.com:<你的用户名>/<仓库>.git
   git push mirror main
   ```
2. **手工把仓库搬走**：`git bundle create /tmp/repo.bundle --all`，scp 回本机再 push。
3. **接受只有服务器有最新内容**：备份里的归档已经包含全部文件（只是没有提交历史）。

---

## 七、故障排查

| 症状 | 先查什么 | 常见原因 |
| --- | --- | --- |
| 全站 502 | `docker compose ps`；`docker compose logs caddy` | Caddyfile 语法错（跑 `validate`）；证书还没签下来 |
| 全站连不上但容器在跑 | `sudo ss -lntp \| grep -E ':80\|:443'` | 安全组没放行 80/443；有别的进程占了端口 |
| 证书签不下来 | `docker compose logs caddy \| grep -i acme` | 域名没解析过来；80 端口不通；域名没备案 |
| `/admin/` 502 | `docker compose logs admin` | 后台缺环境变量（它会在启动时直接报出缺哪个）；`.env` 格式不对 |
| 后台登录不了，日志说 401 | `node tools/passwd.mjs --out deploy/.env` 重设一次 | 口令不对；或者 `.env` 里的哈希被 shell 展开弄坏过（别 `source .env`） |
| 登录页一直提示「尝试过于频繁」 | 等 15 分钟，或 `docker compose restart admin` 清掉计数 | 连错 5 次触发限流 |
| 保存成功但线上还是旧的 | 硬刷一次；`curl -sI https://域名/ \| grep -i cache` | 中间有 CDN/浏览器缓存。后台响应一律 `no-store`，但线上 HTML 是 `no-cache`（需回源确认） |
| 宿主上 `git status` 一片红 / `dubious ownership` | `ls -l /srv/site` 看属主 | `SITE_UID`/`SITE_GID` 与实际属主不一致 |
| 后台报 `Please tell me who you are` | `deploy/.env` 里的 `GIT_AUTHOR_*` | 容器的 git 没有身份信息 |
| 提交历史里没有新文章 | `journalctl -u site-sync`；`docker compose logs admin \| grep -i commit` | git 报错（保存本身是成功的，界面会提示 `committed:false`） |
| 磁盘满了 | `df -h`、`du -sh /var/lib/docker` | 镜像/日志堆积。`docker system prune -a`；确认日志轮转还开着 |
| 容器被 OOM 杀掉 | `dmesg \| grep -i oom` | 内存上限太小；确认 swap 还在（`swapon --show`） |

---

## 八、资源与调优

实测常驻（2 容器）：

| 组件 | 内存 | 说明 |
| --- | --- | --- |
| Caddy | ~40 MB | 上限设了 128 MB |
| admin（Node） | ~70 MB | 上限设了 320 MB |
| Docker 守护进程 | ~80 MB | |

站点本身没有数据库、进程内也没有缓存，所以负载再高也只是 Caddy 在发文件。

已经做掉的带宽优化：

- `music.mp3` 从 6.83 MB 压到 2.68 MB（去掉嵌入封面 + 128 kbps）
- 字体从 Google 搬到本地：**访客侧传输量不变**（`unicode-range` 分片照旧按需取），
  但不再需要访问国外域名。磁盘上占 6.8 MB
- 静态资源走 zstd/gzip；图片和字体长缓存

如果以后带宽还是吃紧，把 `music.mp3` 和 `assets/img/*` 挪到对象存储（OSS/COS）
是最省事的一步，不需要改代码，只改引用地址。

---

## 九、安全须知

已经做了的：

- 后台**不发布端口**，只能经 Caddy 进来 —— 绕不过 HTTPS，也绕不过 Origin 校验
- 口令用 scrypt(N=32768) 存储，常量时间比较
- 会话是无状态签名 cookie：`HttpOnly` + `Secure` + `SameSite=Lax` + `Path=/admin`
- 登录限流 5 次 / 15 分钟，按真实 IP；连用户名不对和口令不对的提示文字都一样
- 写请求一律校验 `Origin`；JSON 接口还要求 `Content-Type: application/json`
- 上传按**文件头**认类型，不信 `Content-Type`
- 公开面是允许列表：`/tools/`、`/server/`、`/deploy/`、`/blog/posts/*.md`、`/.git/*` 全是 404
- 静态解析只认显式路径表，没有 basename 兜底
- 生产模式下 `/site/` 预览整个关掉（那个路由会把仓库连同 `.git` 一起挂出去）

你需要留意的：

- **`deploy/.env` 是凭据**。别提交、别贴聊天记录、备份归档也要当敏感文件对待。
- **系统安全更新**：`sudo apt-get update && sudo apt-get upgrade`（或开 `unattended-upgrades`
  只打安全补丁）。Docker 镜像更新是手动的：改 tag → `docker compose up -d --build`。
- **不要**把 4322 端口发布到公网。`docker-compose.yml` 里用的是 `expose`，
  改成 `ports` 就等于把一个只有单层口令保护的后台直接摆在公网上。
- 定期看一眼 `docker compose logs admin` 里的 `[auth] 登录失败` 行。
  如果出现大量来自陌生 IP 的失败，考虑在 Caddy 那一层再加一道 IP 白名单。

---

## 十、改这个目录时要一起改的地方

- 改 `systemd/*.in` 的占位符 → 同步改 `bootstrap.sh` 里的 `sed` 替换
  （`deploy/scripts.test.mjs` 会验这一致性）
- 改 `Caddyfile` 的公开面 → 跑 `node deploy/caddyfile.test.mjs` 和真机 `caddy validate`
- 改镜像 tag → 跑一遍 `caddyfile.test.mjs`（它的 `validate` 用的是本地 caddy，
  版本尽量和镜像对齐）
- 改后台的接口 → `server/admin.test.mjs`、`server/login.test.mjs`、`server/web.test.mjs`

本地跑全套：

```bash
node tools/check.mjs && node tools/md.test.mjs && node tools/home.test.mjs
node tools/fonts.mjs --check && node tools/build.mjs --check
node server/admin.test.mjs && node server/login.test.mjs
CADDY_BIN=/path/to/caddy node deploy/caddyfile.test.mjs
CADDY_BIN=/path/to/caddy node deploy/stack.test.mjs    # 整条链路：反代 + 生产模式后台
BASH_BIN=/bin/bash       node deploy/scripts.test.mjs  # 含 bash -n、envval、备份、systemd 模板
# 需要浏览器调试端口的两个：
node server/web.test.mjs
node tools/verify.mjs
```

`preflight.sh` 是给服务器跑的，本地验它只要语法检查（`scripts.test.mjs` 里有）：

```bash
bash -n deploy/*.sh
```

`stack.test.mjs` 是最接近真实部署的一个：它把真 Caddy 和真后台接起来，
在一个临时副本里走完"登录 → 传图 → 发文 → 线上可见 → 删文 → 恢复原样"，
连自动提交的作者都查。**但它仍然覆盖不到容器那一层** —— bind mount、
`user:` 的 uid 映射、healthcheck、镜像能不能拉下来，这些只有真机知道。
所以下面的验收清单不是可选项。
