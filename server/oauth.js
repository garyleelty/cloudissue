/**
 * OAuth 登录：provider 注册表 + 授权码流程的胶水层。
 *
 * 本轮交付 GitHub 端到端（技术团队最常见的入口）；注册表结构对
 * 飞书/企微开放——各自实现 token/userinfo 的差异端点即可挂进同一套
 * 路由与身份绑定逻辑。
 *
 * 安全模型：
 *   · state 双保险——服务端 HMAC 签名（10 分钟时效）+ 短期 httpOnly cookie
 *     双写双比对，防 CSRF 与回调劫持；
 *   · code → token 交换只在服务端进行，client_secret 永不出服务；
 *   · 端点 URL 可经环境变量覆盖（测试注入 mock provider），默认指向真实 GitHub。
 */
import { createHmac } from 'node:crypto';

/**
 * Provider 注册表。enabled = client_id/secret 均已配置。
 * 端点可用 OAUTH_<PROVIDER>_<NAME>_URL 覆盖（测试注入 mock provider）。
 */
function buildRegistry() {
  const github = {
    id: 'github',
    label: 'GitHub',
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    scope: 'read:user',
    authUrl: process.env.OAUTH_GITHUB_AUTH_URL || 'https://github.com/login/oauth/authorize',
    tokenUrl: process.env.OAUTH_GITHUB_TOKEN_URL || 'https://github.com/login/oauth/access_token',
    userUrl: process.env.OAUTH_GITHUB_USER_URL || 'https://api.github.com/user',
  };
  return { github };
}

export function listProviders() {
  const registry = buildRegistry();
  return Object.values(registry).map((p) => ({
    id: p.id,
    label: p.label,
    enabled: Boolean(p.clientId && p.clientSecret),
  }));
}

export function getProvider(id) {
  const p = buildRegistry()[id];
  if (!p) return null;
  return { ...p, enabled: Boolean(p.clientId && p.clientSecret) };
}

/**
 * state 签名：HMAC(secret, providerId.timestamp[.userId])，10 分钟时效。
 * userId 可选——登录态下发起时编码进去，回调据此区分「绑定」与「登录/注册」
 * 两种语义（防 CSRF 与回调重放；第三方无法伪造签名或篡改 userId）。
 */
export function makeState(secret, providerId, userId = null) {
  const payload = `${providerId}.${Date.now()}${userId ? `.${userId}` : ''}`;
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

/** @returns {{ ok: boolean, userId: number | null }} */
export function verifyState(secret, providerId, state) {
  if (!state) return { ok: false, userId: null };
  const parts = state.split('.');
  if (parts.length < 2 || parts.length > 4) return { ok: false, userId: null };
  const [pid, ts, maybeUser, sig] = parts.length === 4 ? parts : [parts[0], parts[1], null, parts[2]];
  if (pid !== providerId) return { ok: false, userId: null };
  if (
    createHmac('sha256', secret)
      .update(`${pid}.${ts}${maybeUser ? `.${maybeUser}` : ''}`)
      .digest('hex') !== sig
  ) {
    return { ok: false, userId: null };
  }
  const age = Date.now() - Number(ts);
  if (!(Number.isFinite(age) && age >= 0 && age <= 10 * 60 * 1000)) return { ok: false, userId: null };
  const r = { ok: true, userId: maybeUser ? Number(maybeUser) : null };
  console.error('DBG verify result:', JSON.stringify(r));
  return r;
}

/**
 * 与第三方交换 access_token 并拉取用户信息。
 * 返回 { providerUserId, username, displayName }；失败返回 null。
 * @param {{ tokenUrl: string, userUrl: string, clientId: string, clientSecret: string }} provider
 * @param {string} code
 * @param {string} redirectUri
 */
export async function fetchOAuthUser(provider, code, redirectUri) {
  try {
    const tokenRes = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) return null;
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) return null;

    const userRes = await fetch(provider.userUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'CloudIssue',
      },
    });
    if (!userRes.ok) return null;
    const profile = await userRes.json();
    const providerUserId = String(profile.id ?? profile.user_id ?? profile.userid ?? '');
    if (!providerUserId) return null;
    return {
      providerUserId,
      username: String(profile.login || profile.username || profile.name || `user_${providerUserId}`).slice(
        0,
        64,
      ),
      displayName: String(profile.name || profile.login || profile.username || '').slice(0, 64),
    };
  } catch (err) {
    loggerWarn(err);
    return null;
  }
}

function loggerWarn(err) {
  // 避免与 auth.js 循环依赖：轻量 console 输出（OAuth 交换失败非敏感细节）
  console.error('[cloudissue-oauth] exchange failed:', err?.message || err);
}
