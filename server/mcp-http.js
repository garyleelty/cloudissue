/**
 * MCP over Streamable HTTP：把看板 MCP tools 暴露给外部 AI 客户端。
 *
 * 人走 Web UI（cookie 会话），AI 走这里（Bearer API Token）——两条入口
 * 最终落到同一套 MCP tools 与同一块 MySQL，数据与校验完全同源。
 *
 * 传输采用「无状态」模式：每个请求独立建立 server/transport 对，
 * 不追踪会话，天然适配一次一发的 tool 调用，也免去会话泄露的清理负担。
 * 挂载点：POST /mcp（鉴权见 authByToken 中间件）。
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createBoardServer, runAsActor } from '../mcp-server/index.js';
import { callTool } from './mcp-client.js';
import { logger } from './logger.js';

const TOKEN_RE = /^Bearer\s+(.+)$/i;

/** Bearer Token → 用户。/mcp 专用（Web 走 cookie，两者互不影响） */
export async function authByToken(req, res, next) {
  try {
    const m = TOKEN_RE.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ error: '缺少 Bearer API Token' });

    const { user } = await callTool('user_get_by_token', { token: m[1].trim() });
    if (!user) return res.status(401).json({ error: 'API Token 无效' });

    req.mcpUser = { id: user.id, username: user.username, displayName: user.displayName };
    next();
  } catch (err) {
    next(err);
  }
}

export const mcpHttpRouter = Router();

mcpHttpRouter.post('/', async (req, res) => {
  // 无状态模式：每请求一组全新实例（官方推荐写法），用完即弃。
  // 调用者身份在构造期绑进实例闭包：Bearer Token 解析出的用户，AI 参数无法伪造
  const server = createBoardServer({ actorId: req.mcpUser?.id ?? null });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    // 调用者身份 = Bearer Token 解析出的用户（authByToken 已挂 req.mcpUser）。
    // 包进 AsyncLocalStorage 后，tool handler 内的权限护栏读取的就是这条可信链路；
    // AI 客户端塞进 JSON-RPC 参数里的任何 actorId 都会被这里的身份覆盖，无法伪造。
    const actorId = req.mcpUser?.id ?? null;
    await runAsActor(actorId, () => transport.handleRequest(req, res, req.body));
  } catch (err) {
    logger.error({ err: err.message }, 'mcp-http request failed');
    if (!res.headersSent) {
      res.status(500).json({ error: 'MCP 服务暂时不可用，请稍后重试' });
    }
  }
});

/** 生成新 token：ci_ + 48 位 hex（含前缀共 51 字符） */
export const generateApiToken = () => `ci_${crypto.randomBytes(24).toString('hex')}`;
