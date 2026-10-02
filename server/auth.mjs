/* =========================================================================
   auth.mjs — 口令、会话与登录限流

   全部用 node:crypto 内置能力，不引第三方库 —— 这是站点"零依赖"这条
   设定的延续，也让 Docker 镜像不需要 npm install。

   三个决定值得说明：

   1. 会话是**无状态签名 cookie**，服务端不存 session 表。
      这个后台只有一个用户，为它维护一张会话表、再操心过期清理和
      "改了密码旧会话还在"的问题，不划算。签名里带过期时间就够了。

   2. scrypt 的 maxmem 必须显式抬高。
      N=32768 / r=8 需要 128*N*r ≈ 33.5 MB，而 Node 默认上限是 32 MB ——
      不传 maxmem 会直接抛 ERR_CRYPTO_INVALID_SCRYPT_PARAMS。这是个
      很容易在部署当天才发现的坑。

   3. 客户端 IP 取 X-Forwarded-For 的**最后一段**。
      Caddy 反代时会把真实对端追加到末尾；客户端自己伪造的值只会排在前面。
      加上 admin 容器不发布端口、只有 Caddy 连得到，这个假设才成立 ——
      限流如果按可伪造的值来算，等于没限流。
   ========================================================================= */
import { randomBytes, scrypt, timingSafeEqual, createHmac } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

/* ------------------------------------------------------------------ 口令 */
export async function hashPassword(password) {
  const salt = randomBytes(32);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("hex"), key.toString("hex")].join("$");
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltHex, keyHex] = parts;
  const salt = Buffer.from(saltHex, "hex");
  const want = Buffer.from(keyHex, "hex");
  if (!salt.length || !want.length) return false;
  let got;
  try {
    got = await scryptAsync(password, salt, want.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

export function newSecret() {
  return randomBytes(32).toString("hex");
}

/* ------------------------------------------------------------------ 会话
   令牌形如 v1.<过期时间戳>.<随机串>.<签名>。
   随机串的作用是让"同一秒签发的两个会话"也不相同，避免令牌被当成固定值缓存。 */
const SESSION_VERSION = "v1";

export function signSession(ttlMs, secret) {
  const exp = Date.now() + ttlMs;
  const nonce = randomBytes(9).toString("base64url");
  const payload = `${SESSION_VERSION}.${exp}.${nonce}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(token, secret) {
  if (!token) return false;
  const parts = String(token).split(".");
  if (parts.length !== 4 || parts[0] !== SESSION_VERSION) return false;
  const [, expStr, nonce, sig] = parts;
  const payload = `${SESSION_VERSION}.${expStr}.${nonce}`;
  const want = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const exp = Number(expStr);
  return Number.isFinite(exp) && Date.now() < exp;
}

/* ------------------------------------------------------------------ cookie */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/* ------------------------------------------------------------------ 限流
   内存计数，按 IP。单用户后台够用：进程重启等于清空，而重启本身不是
   攻击者能触发的事。加了 sweep，防止大量不同 IP 把 Map 撑爆。 */
export class RateLimiter {
  constructor({ max = 5, windowMs = 15 * 60 * 1000, maxEntries = 5000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.hits = new Map();
  }

  sweep(now = Date.now()) {
    for (const [ip, e] of this.hits) {
      if (now - e.first > this.windowMs) this.hits.delete(ip);
    }
    if (this.hits.size > this.maxEntries) this.hits.clear();
  }

  /* 只看"到没到上限"，不改状态 —— 登录成功和失败要分别调 reset / fail。 */
  check(ip, now = Date.now()) {
    const e = this.hits.get(ip);
    if (!e) return { allowed: true };
    if (now - e.first > this.windowMs) {
      this.hits.delete(ip);
      return { allowed: true };
    }
    if (e.count >= this.max) {
      return { allowed: false, retryAfter: Math.ceil((e.first + this.windowMs - now) / 1000) };
    }
    return { allowed: true };
  }

  fail(ip, now = Date.now()) {
    const e = this.hits.get(ip);
    if (!e || now - e.first > this.windowMs) {
      this.hits.set(ip, { first: now, count: 1 });
    } else {
      e.count++;
    }
    this.sweep(now);
  }

  reset(ip) {
    this.hits.delete(ip);
  }
}

export function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const list = String(xff).split(",");
    const last = list[list.length - 1].trim();
    if (last) return last;
  }
  return req.socket?.remoteAddress || "unknown";
}
