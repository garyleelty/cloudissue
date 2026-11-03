/**
 * CloudIssue · HTTP 服务
 * ---------------------------------------------------------------
 * 职责边界非常明确：
 *   · 对外提供 REST API 与静态资源；
 *   · 自身不连接 MySQL，所有数据读写全部通过 MCP Client 调用
 *     mcp-server 暴露的 tools 完成。
 * 即：HTTP 层 → MCP Client → MCP Server(tools) → MySQL
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, '..');

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

/** 环境变量 fail-fast 校验：配置错误应让进程立刻退出 */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().max(65535).default(5173),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
});
const parsedEnv = EnvSchema.safeParse(process.env);
if (!parsedEnv.success) {
  for (const issue of parsedEnv.error.issues) {
    console.error(`[cloudissue] 环境变量错误 ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}
const { PORT, LOG_LEVEL } = parsedEnv.data;

const MCP_ENTRY = path.join(PROJECT_ROOT, 'mcp-server', 'index.js');

// ------------------------------------------------------------------
// 结构化日志（JSON 行）。MCP 子进程自行写 stderr，这里只管 HTTP 层
// ------------------------------------------------------------------
const logger = pino({ level: LOG_LEVEL, base: { svc: 'cloudissue-http' } });

// ------------------------------------------------------------------
// MCP Client（单例，惰性连接；子进程死亡后自动失效、下次调用重连）
// ------------------------------------------------------------------
let mcpClientPromise = null;

function connectMcp() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DB_HOST: process.env.DB_HOST || '127.0.0.1',
      DB_PORT: process.env.DB_PORT || '3306',
      DB_USER: process.env.DB_USER || 'root',
      DB_PASSWORD: process.env.DB_PASSWORD || '',
      DB_NAME: process.env.DB_NAME || 'issue_board',
    },
    stderr: 'inherit',
  });

  const client = new Client({ name: 'cloudissue-http', version: '1.0.0' });
  // 子进程崩溃/退出时必须失效缓存，否则所有后续调用都打在一具尸体上
  client.onclose = () => {
    if (mcpClientPromise) {
      logger.warn('mcp data server connection closed, 将在下次调用时重连');
      mcpClientPromise = null;
    }
  };
  client.onerror = (err) => {
    logger.error({ err: err.message }, 'mcp client transport error');
  };
  return client
    .connect(transport)
    .then(() => client); // connect() 的返回值不是 client，必须显式回传
}

function getMcpClient() {
  if (!mcpClientPromise) {
    mcpClientPromise = connectMcp().catch((err) => {
      // 连接失败时清空缓存，允许下一次请求重试
      mcpClientPromise = null;
      throw err;
    });
  }
  return mcpClientPromise;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 调用一个 MCP tool 并返回解析后的 JSON。
 * - 业务校验失败（McpError InvalidParams）→ 400 + 原始文案；
 * - 子进程断连 → 失效缓存并重试一次；
 * - 其余一律视为系统故障 → 502 通用文案，细节只进日志。
 */
async function callTool(name, args = {}, attempt = 0) {
  let res;
  try {
    const client = await getMcpClient();
    res = await client.callTool({ name, arguments: args });
  } catch (err) {
    const transient =
      err instanceof McpError && err.code === ErrorCode.ConnectionClosed
        ? true
        : /closed|not connected/i.test(String(err?.message));
    if (transient && attempt < 1) {
      mcpClientPromise = null;
      await sleep(200);
      return callTool(name, args, attempt + 1);
    }
    if (err instanceof McpError && err.code === ErrorCode.InvalidParams) {
      throw Object.assign(new Error(err.message), { status: 400 });
    }
    logger.error({ err: err.message, tool: name }, 'mcp call failed');
    throw Object.assign(new Error('数据服务暂时不可用，请稍后重试'), { status: 502 });
  }

  if (res.isError) {
    const text = res.content?.map((c) => c.text).join('\n') || '数据操作失败';
    // SDK 会把 tool 内抛出的 McpError 转成 isError 文本（带 "MCP error <code>:" 前缀）
    const m = /^MCP error (-?\d+): (.*)$/s.exec(text);
    if (m && Number(m[1]) === ErrorCode.InvalidParams) {
      // 业务校验失败：文案面向用户，直接透出
      throw Object.assign(new Error(m[2]), { status: 400 });
    }
    logger.error({ tool: name, detail: text }, 'mcp tool reported error');
    throw Object.assign(new Error('数据服务暂时不可用，请稍后重试'), { status: 502 });
  }

  const raw = res.content?.[0]?.text;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    logger.error({ tool: name }, 'mcp tool returned non-JSON payload');
    return {};
  }
}

// ------------------------------------------------------------------
// Express 应用
// ------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(pinoHttp({ logger, genReqId: () => crypto.randomUUID() }));

// 共享枚举常量直接以 ESM 形式提供给前端，避免前后端文案不一致
app.use('/shared', express.static(path.join(PROJECT_ROOT, 'shared')));
app.use(express.static(path.join(PROJECT_ROOT, 'public')));

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

/** 健康检查：确认 MCP 链路与数据库均可用 */
app.get('/api/health', asyncHandler(async (_req, res) => {
  const info = await callTool('db_health');
  res.json({ ok: true, viaMcp: true, ...info });
}));

/** 获取整块看板 */
app.get('/api/issues', asyncHandler(async (_req, res) => {
  const data = await callTool('issue_list');
  res.json(data);
}));

/** 新建任务 */
app.post('/api/issues', asyncHandler(async (req, res) => {
  const data = await callTool('issue_create', req.body || {});
  res.status(201).json(data);
}));

/** 乐观锁冲突：MCP 返回 conflict 时统一映射为 409（校验仍留在 MCP 内） */
const conflictResponse = (res, data) =>
  res.status(409).json({
    error: data.message || '任务已被其他人修改，请刷新后重试',
    conflict: true,
    currentVersion: data.currentVersion,
    issue: data.issue,
  });

/** 更新任务字段 */
app.put('/api/issues/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '非法的任务 ID' });
  }
  const data = await callTool('issue_update', { ...(req.body || {}), id });
  if (data.conflict) return conflictResponse(res, data);
  res.json(data);
}));

// ------------------------------------------------------------------
// 批量操作
//
// 刻意不新增 MCP tool：批量只是「对同一批 id 循环调用既有 tool」，
// 校验（失败原因必填、状态枚举、乐观锁）仍然留在 MCP 内部，
// HTTP 层只负责编排与汇总结果，不碰任何 SQL。
//
// 注意：这两个路由必须注册在 /api/issues/:id/move 之前，
// 否则 'batch' 会被 :id 吃掉，直接返回「非法的任务 ID」。
// ------------------------------------------------------------------

/** 校验并归一化 id 列表：去重、去非法值，空列表返回 null */
function parseIds(input) {
  if (!Array.isArray(input)) return null;
  const ids = [...new Set(input.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? ids : null;
}

/**
 * 解析批量移动入参。两种形态：
 *   · items: [{ id, expectedVersion? }] —— 新形态，逐卡携带乐观锁版本号；
 *   · ids:   number[]                   —— 旧形态，退化为「后写覆盖」，保持兼容。
 */
function parseBatchItems(body) {
  if (Array.isArray(body?.items)) {
    const items = [];
    const seen = new Set();
    for (const it of body.items) {
      const id = Number(it?.id);
      if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      const v = Number(it?.expectedVersion);
      items.push({
        id,
        expectedVersion: Number.isInteger(v) && v > 0 ? v : undefined,
      });
    }
    return items.length ? items : null;
  }
  const ids = parseIds(body?.ids);
  return ids ? ids.map((id) => ({ id, expectedVersion: undefined })) : null;
}

/** 目标列当前最后一张卡片的 id，用于把批量移动的结果追加到列尾 */
async function tailIdOf(toStatus, exclude) {
  const { issues = [] } = await callTool('issue_list');
  const rest = issues.filter((i) => i.status === toStatus && !exclude.has(i.id));
  return rest.length ? Number(rest[rest.length - 1].id) : null;
}

/** 批量移动：逐个走 issue_move，失败的单独汇总，不影响其余卡片 */
app.post('/api/issues/batch/move', asyncHandler(async (req, res) => {
  const items = parseBatchItems(req.body);
  if (!items) return res.status(400).json({ error: '请先选择要移动的任务' });

  const { toStatus, failReason } = req.body || {};
  const exclude = new Set(items.map((it) => it.id));
  const tailId = await tailIdOf(toStatus, exclude).catch(() => null);

  const moved = [];
  const failed = [];
  let afterId = tailId;

  for (const { id, expectedVersion } of items) {
    try {
      await callTool('issue_move', {
        id,
        toStatus,
        afterId,
        failReason: failReason ?? '',
        expectedVersion,
      });
      moved.push(id);
      afterId = id; // 依次接在前一张之后，保持勾选顺序
    } catch (err) {
      failed.push({ id, error: err.message });
    }
  }

  if (!moved.length) {
    return res.status(400).json({ error: failed[0]?.error || '批量移动失败', failed });
  }
  res.json({ moved: moved.length, ids: moved, failed, toStatus });
}));

/** 批量删除 */
app.post('/api/issues/batch/delete', asyncHandler(async (req, res) => {
  const ids = parseIds(req.body?.ids);
  if (!ids) return res.status(400).json({ error: '请先选择要删除的任务' });

  const deleted = [];
  const failed = [];
  for (const id of ids) {
    try {
      await callTool('issue_delete', { id });
      deleted.push(id);
    } catch (err) {
      failed.push({ id, error: err.message });
    }
  }

  if (!deleted.length) {
    return res.status(400).json({ error: failed[0]?.error || '批量删除失败', failed });
  }
  res.json({ deleted: deleted.length, ids: deleted, failed });
}));

/** 移动 / 排序 */
app.post('/api/issues/:id/move', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '非法的任务 ID' });
  }
  const data = await callTool('issue_move', { ...(req.body || {}), id });
  if (data.conflict) return conflictResponse(res, data);
  res.json(data);
}));

/** 删除任务 */
app.delete('/api/issues/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '非法的任务 ID' });
  }
  const data = await callTool('issue_delete', { id });
  res.json(data);
}));

// 统一错误处理：4xx 保留文案给用户，5xx 一律通用文案（细节只进日志）
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) {
    logger.error({ err: err.message, stack: err.stack, reqId: req.id, path: req.path }, 'unhandled error');
  }
  res.status(status).json({
    error: status >= 500 ? '服务器内部错误，请稍后重试' : err.message || '请求失败',
    requestId: req.id,
  });
});

// ------------------------------------------------------------------
// 启动：先通过 MCP 完成建库/建表与按需初始化
// ------------------------------------------------------------------
async function start() {
  try {
    const boot = await callTool('board_bootstrap');
    logger.info(
      boot.seeded
        ? `数据库就绪（经 MCP）：已写入 ${boot.count} 条示例任务`
        : '数据库就绪（经 MCP）：保留现有数据'
    );
  } catch (err) {
    logger.error('数据库初始化失败，请检查 MySQL 连接配置（.env）');
    logger.error(err.message);
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    logger.info(`看板已启动： http://localhost:${PORT}`);
  });

  // 优雅停机：停接新请求 → 关 MCP client（连带终止子进程，子进程清池退出）
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, '收到退出信号，开始优雅停机');
    server.close(async () => {
      try {
        const client = await mcpClientPromise?.catch(() => null);
        await client?.close();
      } finally {
        process.exit(0);
      }
    });
    // 兜底：连接挂死也要退出，交给进程管理器重启
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // crash-only：未捕获异常直接退出，由容器/进程管理器重启恢复
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaughtException');
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    logger.fatal({ err: err?.message ?? String(err) }, 'unhandledRejection');
    process.exit(1);
  });
}

start();
