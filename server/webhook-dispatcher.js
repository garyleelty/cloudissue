/**
 * Webhook 分发器：把站内通知外发到看板订阅的 Webhook 端点。
 *
 * 为什么在 HTTP 层消费而不是 MCP 数据层：投递是网络 IO，放数据层会阻塞
 * 事务与 stdio 协议；而事件源统一用 notifications 表——人与 AI 的写操作
 * 都已经落在这条流上，分发器只管「未投递的通知 × 看板订阅的 webhook」。
 *
 * 可靠性：webhook_dispatch 记录每个（通知 × webhook）的投递状态，
 * 失败按 attempts 重试（指数上限 5 次后放弃），不影响站内通知本身。
 */
import crypto from 'node:crypto';
import { callTool } from './mcp-client.js';
import { logger } from './logger.js';
import { broadcastChanged } from './bus.js';

const DISPATCH_INTERVAL = Number(process.env.WEBHOOK_DISPATCH_INTERVAL || 10_000);
// 重试上限（attempts < 5）在数据层 webhook_pending 查询里判定，这里只负责投递
const FETCH_TIMEOUT = 5000;

let timer = null;
let running = false;

/** HMAC-SHA256 签名（generic 类型的防伪造校验头） */
function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** 钉钉加签机器人的 URL 签名（timestamp + secret → &timestamp=..&sign=..） */
function dingtalkSignedUrl(url, secret) {
  if (!secret) return url;
  const ts = Date.now();
  const stringToSign = `${ts}\n${secret}`;
  const signStr = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}timestamp=${ts}&sign=${encodeURIComponent(signStr)}`;
}

/** 按 webhook 类型包装载荷 */
function buildPayload(type, notif) {
  const text = `${notif.title}${notif.actor ? `（by ${notif.actor}）` : ''}`;
  switch (type) {
    case 'dingtalk':
    case 'wecom':
      return { msgtype: 'text', text: { content: `[CloudIssue] ${text}` } };
    case 'feishu':
      return { msg_type: 'text', content: { text: `[CloudIssue] ${text}` } };
    default:
      return {
        event: notif.type,
        title: notif.title,
        actor: notif.actor || '',
        issueId: notif.issue_id,
        boardId: notif.board_id,
        createdAt: notif.created_at,
      };
  }
}

/** 投递单个 webhook；返回是否成功 */
async function deliver(webhook, notif) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    let url = webhook.url;
    let payload = buildPayload(webhook.type, notif);
    const isGeneric = webhook.type === 'generic';
    const headers = { 'Content-Type': 'application/json' };
    if (webhook.type === 'dingtalk') url = dingtalkSignedUrl(url, webhook.secret);
    const body = JSON.stringify(payload);
    if (isGeneric && webhook.secret) {
      headers['X-CloudIssue-Signature'] = sign(webhook.secret, body);
      headers['X-CloudIssue-Event'] = notif.type;
    }
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, error: '' };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 单轮分发：找「未成功投递且未超重试上限」的（通知 × webhook）组合，
 * 逐个投递并记录结果。一轮最多 50 条，避免偶发大量事件时压满连接。
 */
export async function dispatchOnce() {
  // 待投递清单：站内通知 × 看板启用的 webhook（事件订阅匹配），
  // 排除已成功 / 已达重试上限 / 已有记录的（新组合随后 INSERT）
  const pending = await callTool('webhook_pending', {});
  if (!pending?.items?.length) return 0;

  let delivered = 0;
  for (const item of pending.items) {
    const { ok, error } = await deliver(item.webhook, item.notification);
    try {
      await callTool('webhook_dispatch_record', {
        notificationId: item.notification.id,
        webhookId: item.webhook.id,
        ok,
        error: error.slice(0, 250),
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'webhook dispatch record failed');
      continue; // 记录失败则不计数，下轮重投
    }
    if (ok) delivered += 1;
  }
  if (pending.items.length) {
    logger.info({ total: pending.items.length, delivered }, 'webhook dispatch round');
    // 兜底广播：AI 动作不经 HTTP 路由，靠分发器轮询发现新事件后补推（≤ 轮询周期）
    broadcastChanged('dispatcher');
  }
  return delivered;
}

/** 启动周期分发（server/index.js 启动时调用一次） */
export function startWebhookDispatcher() {
  if (timer) return;
  // 启动即先跑一轮（服务重启期间积压的通知会补发）
  dispatchOnce().catch((err) => logger.error({ err: err.message }, 'webhook dispatch round failed'));
  timer = setInterval(() => {
    if (running) return;
    running = true;
    dispatchOnce()
      .catch((err) => logger.error({ err: err.message }, 'webhook dispatch round failed'))
      .finally(() => {
        running = false;
      });
  }, DISPATCH_INTERVAL);
  logger.info({ intervalMs: DISPATCH_INTERVAL }, 'webhook dispatcher started');
}

export function stopWebhookDispatcher() {
  if (timer) clearInterval(timer);
  timer = null;
}
