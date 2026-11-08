/**
 * 认证与用户体系：注册 / 登录 / 登出 / 会话 / 改密。
 *
 * 设计：
 *   · JWT 放 httpOnly + SameSite=Lax cookie，比 localStorage 抗 XSS；
 *   · payload 带 token_version（tv），每次请求经 MCP 回库校验——改密后
 *     bump 版本号即可让所有旧会话立即失效；
 *   · 看板为共享团队模式：登录用户同看一块板、均可增删改，无任务归属。
 *
 * 架构边界：口令哈希（bcryptjs）在本层完成，用户数据一律经 MCP tools 读写。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Router } from 'express';
import { z } from 'zod';
import { callTool } from './mcp-client.js';
import { runAsActor } from '../mcp-server/index.js';
import { generateApiToken } from './mcp-http.js';
import { listProviders, getProvider, makeState, verifyState, fetchOAuthUser } from './oauth.js';
import { logger } from './logger.js';

// 本模块的 env 校验在 import 阶段执行（早于 index.js 的模块体），
// 必须自己加载 .env，与 mcp-server/db.js 同一模式
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '..', '.env') });

// 环境变量 fail-fast：缺 JWT_SECRET 直接退出，绝不退化为弱默认
const EnvSchema = z.object({
  JWT_SECRET: z.string().min(16, 'JWT_SECRET 至少 16 位（可用 openssl rand -hex 32 生成）'),
  JWT_EXPIRES: z.string().default('7d'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  for (const issue of parsed.error.issues) {
    logger.error(`环境变量错误 ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}
const { JWT_SECRET, JWT_EXPIRES, COOKIE_SECURE } = parsed.data;

const COOKIE_NAME = 'ci_session';
const BCRYPT_ROUNDS = 10;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;

const AuthSchema = z.object({
  username: z.string().regex(USERNAME_RE, '用户名需 3-32 位，仅字母/数字/下划线/连字符'),
  password: z.string().min(8, '密码至少 8 位').max(72, '密码最长 72 位（bcrypt 限制）'),
});

const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });

function setSessionCookie(res, user) {
  const token = jwt.sign({ sub: user.id, username: user.username, tv: user.tokenVersion }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES,
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: 7 * 24 * 3600 * 1000,
    path: '/',
  });
}

/** 鉴权中间件：校验 JWT → 回库确认用户与 token_version → 挂 req.user */
export async function authRequired(req, res, next) {
  try {
    const raw = req.cookies?.[COOKIE_NAME];
    if (!raw) return res.status(401).json({ error: '未登录' });

    let payload;
    try {
      payload = jwt.verify(raw, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }

    const { user } = await callTool('user_get_by_id', { id: payload.sub });
    if (!user || user.tokenVersion !== payload.tv) {
      return res.status(401).json({ error: '登录状态已失效，请重新登录' });
    }

    req.user = publicUser(user);
    // 后续所有数据操作都带调用者身份：MCP 数据层据此做看板权限护栏
    runAsActor(user.id, () => next());
  } catch (err) {
    next(err);
  }
}

export const authRouter = Router();

/** 注册（开放注册；由 /api/auth 上的限流兜底防爆破） */
authRouter.post('/register', async (req, res, next) => {
  try {
    const parsedBody = AuthSchema.safeParse(req.body || {});
    if (!parsedBody.success) {
      return res.status(400).json({ error: parsedBody.error.issues[0].message });
    }
    const { username, password } = parsedBody.data;
    const displayName =
      String(req.body?.displayName || '')
        .trim()
        .slice(0, 64) || username;

    const { user: existing } = await callTool('user_get_by_username', { username });
    if (existing) return res.status(400).json({ error: '用户名已被占用' });

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const apiToken = generateApiToken();
    const { id } = await callTool('user_create', { username, displayName, passwordHash, apiToken });

    const { user } = await callTool('user_get_by_id', { id });
    setSessionCookie(res, user);
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

/** 登录：不区分「用户不存在」与「密码错误」，避免用户名枚举 */
authRouter.post('/login', async (req, res, next) => {
  try {
    const parsedBody = AuthSchema.safeParse(req.body || {});
    if (!parsedBody.success) {
      return res.status(400).json({ error: parsedBody.error.issues[0].message });
    }
    const { username, password } = parsedBody.data;

    const { user } = await callTool('user_get_by_username', { username });
    const okPwd = user ? await bcrypt.compare(password, user.passwordHash) : false;
    if (!user || !okPwd) return res.status(401).json({ error: '用户名或密码错误' });

    setSessionCookie(res, user);
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

/** 登出：清 cookie 即可（JWT 无状态；需要强制全端下线走改密 bump tv） */
authRouter.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

/** 当前会话用户（前端启动时探测登录态） */
authRouter.get('/me', authRequired, (req, res) => {
  res.json({ user: req.user });
});

/**
 * 查看 API Token（AI/MCP 客户端接入凭据）。历史用户可能尚无 token，
 * 查看时惰性生成，避免额外的迁移脚本。
 */
authRouter.get('/token', authRequired, async (req, res, next) => {
  try {
    const { user } = await callTool('user_get_by_id', { id: req.user.id });
    if (!user) return res.status(401).json({ error: '登录状态已失效，请重新登录' });
    if (user.apiToken) return res.json({ token: user.apiToken });

    const token = generateApiToken();
    await callTool('user_set_api_token', { id: user.id, apiToken: token });
    res.json({ token });
  } catch (err) {
    next(err);
  }
});

/** 轮换 API Token：旧 token 立即作废（怀疑泄露或人员变动时使用） */
authRouter.post('/token/rotate', authRequired, async (req, res, next) => {
  try {
    const token = generateApiToken();
    await callTool('user_set_api_token', { id: req.user.id, apiToken: token });
    res.json({ token });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// OAuth 登录（授权码流程；provider 见 server/oauth.js）
// ------------------------------------------------------------------

/** 服务端已配置的 provider 列表（前端按此渲染第三方登录按钮） */
authRouter.get('/oauth/providers', (_req, res) => {
  res.json({ providers: listProviders().filter((p) => p.enabled) });
});

const OAUTH_STATE_COOKIE = 'ci_oauth_state';

/** 第三方登录入口：302 到 provider 授权页（带签名 state + 双写 cookie）。
 * 登录态下发起 = 绑定该第三方身份到当前账号（state 里编码 userId，回调验签取回）。 */
authRouter.get('/oauth/:provider/start', async (req, res) => {
  const provider = getProvider(req.params.provider);
  if (!provider?.enabled) return res.status(404).json({ error: '该登录方式未配置' });

  // 可选会话：有合法 cookie 即编码绑定语义（tv 校验防吊销会话绑定）
  let boundUserId = null;
  const rawSession = req.cookies?.[COOKIE_NAME];
  if (rawSession) {
    try {
      const payload = jwt.verify(rawSession, JWT_SECRET);
      const { user } = await callTool('user_get_by_id', { id: payload.sub });
      if (user && user.tokenVersion === payload.tv) boundUserId = user.id;
    } catch {
      /* 未登录/过期：走登录语义 */
    }
  }

  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/oauth/${provider.id}/callback`;
  const state = makeState(JWT_SECRET, provider.id, boundUserId);
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: 10 * 60 * 1000,
    path: '/',
  });
  const url = new URL(provider.authUrl);
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', provider.scope);
  res.redirect(url.toString());
});

/**
 * 回调：验 state → code 换 token → 拉用户 → 查绑定：
 *   · 已绑定 → 直接登录；
 *   · 未绑定且当前有会话 → 绑定到当前账号（登录态下绑定入口）；
 *   · 未绑定且无会话 → 自动注册新账号（gh_ 前缀用户名 + 随机不可登录口令）。
 * 全部完成后清 state cookie 并重定向回首页（会话 cookie 已下发）。
 */
authRouter.get('/oauth/:provider/callback', async (req, res, next) => {
  try {
    const provider = getProvider(req.params.provider);
    if (!provider?.enabled) return res.status(404).json({ error: '该登录方式未配置' });

    const state = String(req.query.state || '');
    const stateCookie = req.cookies?.[OAUTH_STATE_COOKIE];
    const verified = verifyState(JWT_SECRET, provider.id, state);
    if (!verified.ok || state !== stateCookie) {
      return res.status(401).json({ error: 'OAuth 状态校验失败（过期或伪造），请重试' });
    }
    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });

    const code = String(req.query.code || '');
    if (!code) return res.status(400).json({ error: '缺少授权码' });
    const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/oauth/${provider.id}/callback`;
    const oauthUser = await fetchOAuthUser(provider, code, redirectUri);
    if (!oauthUser) return res.status(502).json({ error: '第三方登录失败：无法获取用户信息' });

    const { user: bound } = await callTool('oauth_identity_find', {
      provider: provider.id,
      providerUserId: oauthUser.providerUserId,
    });

    let user;
    if (bound) {
      // 登录态下发起绑定、但该身份已绑别的账号 → 明确冲突而不是静默切号
      if (verified.userId && bound.id !== verified.userId) {
        return res.status(409).json({ error: '该第三方身份已绑定其他账号，请先用对应账号登录后解绑' });
      }
      user = bound; // 未登录：身份即凭据，登录绑定它的账号
    } else if (verified.userId) {
      // state 携带登录态 userId = 绑定该账号
      await callTool('oauth_identity_link', {
        provider: provider.id,
        providerUserId: oauthUser.providerUserId,
        userId: verified.userId,
      });
      user = await callTool('user_get_by_id', { id: verified.userId }).then((r) => r.user);
    } else {
      // 自动注册：用户名 gh_<login>（冲突追加序号），口令为不可登录的随机串
      const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), BCRYPT_ROUNDS);
      const apiToken = generateApiToken();
      let username = `${provider.id.slice(0, 4)}_${oauthUser.username}`
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 32);
      for (let i = 0; ; i += 1) {
        const { user: taken } = await callTool('user_get_by_username', { username });
        if (!taken) break;
        username = `${provider.id.slice(0, 4)}_${oauthUser.username}${i + 1}`
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .slice(0, 32);
      }
      const { id } = await callTool('user_create', {
        username,
        displayName: oauthUser.displayName || oauthUser.username,
        passwordHash,
        apiToken,
      });
      await callTool('oauth_identity_link', {
        provider: provider.id,
        providerUserId: oauthUser.providerUserId,
        userId: id,
      });
      user = await callTool('user_get_by_id', { id }).then((r) => r.user);
    }

    if (!user) return res.status(502).json({ error: '账号创建失败' });
    setSessionCookie(res, user);
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

/** 改密：校验旧密码 → 写新哈希 → bump token_version → 重新发 cookie */
authRouter.put('/password', authRequired, async (req, res, next) => {
  try {
    const PwdSchema = z.object({
      oldPassword: z.string().min(1, '请输入原密码').max(72),
      newPassword: z.string().min(8, '新密码至少 8 位').max(72),
    });
    const parsedBody = PwdSchema.safeParse(req.body || {});
    if (!parsedBody.success) {
      return res.status(400).json({ error: parsedBody.error.issues[0].message });
    }
    const { oldPassword, newPassword } = parsedBody.data;

    const { user } = await callTool('user_get_by_id', { id: req.user.id });
    if (!user) return res.status(401).json({ error: '登录状态已失效，请重新登录' });

    const okPwd = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!okPwd) return res.status(400).json({ error: '原密码不正确' });

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    // 直接改哈希 + bump tv：旧会话（含其他标签页/设备）全部失效
    await callTool('user_update_auth', {
      id: user.id,
      passwordHash,
      bumpTokenVersion: true,
    });

    const fresh = { ...user, passwordHash, tokenVersion: user.tokenVersion + 1 };
    setSessionCookie(res, fresh);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
