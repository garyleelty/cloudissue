/**
 * CloudIssue · HTTP 服务
 * ---------------------------------------------------------------
 * 职责边界非常明确：
 *   · 对外提供 REST API 与静态资源；
 *   · 自身不连接 MySQL，所有数据读写全部通过 MCP Client 调用
 *     mcp-server 暴露的 tools 完成。
 * 即：HTTP 层 → MCP Client → MCP Server(tools) → MySQL
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, '..');

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

const PORT = Number(process.env.PORT || 5173);
const MCP_ENTRY = path.join(PROJECT_ROOT, 'mcp-server', 'index.js');

// ------------------------------------------------------------------
// MCP Client（单例，惰性连接）
// ------------------------------------------------------------------
let mcpClientPromise = null;

async function getMcpClient() {
  if (mcpClientPromise) return mcpClientPromise;

  mcpClientPromise = (async () => {
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
    await client.connect(transport);
    return client;
  })().catch((err) => {
    // 连接失败时清空缓存，允许下一次请求重试
    mcpClientPromise = null;
    throw err;
  });

  return mcpClientPromise;
}

/** 调用一个 MCP tool 并返回解析后的 JSON */
async function callTool(name, args = {}) {
  const client = await getMcpClient();
  const res = await client.callTool({ name, arguments: args });

  if (res.isError) {
    const text = res.content?.map((c) => c.text).join('\n') || '数据操作失败';
    throw Object.assign(new Error(text), { status: 400 });
  }

  const raw = res.content?.[0]?.text;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------
// Express 应用
// ------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));

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

/** 目标列当前最后一张卡片的 id，用于把批量移动的结果追加到列尾 */
async function tailIdOf(toStatus, exclude) {
  const { issues = [] } = await callTool('issue_list');
  const rest = issues.filter((i) => i.status === toStatus && !exclude.has(i.id));
  return rest.length ? Number(rest[rest.length - 1].id) : null;
}

/** 批量移动：逐个走 issue_move，失败的单独汇总，不影响其余卡片 */
app.post('/api/issues/batch/move', asyncHandler(async (req, res) => {
  const ids = parseIds(req.body?.ids);
  if (!ids) return res.status(400).json({ error: '请先选择要移动的任务' });

  const { toStatus, failReason } = req.body || {};
  const exclude = new Set(ids);
  const tailId = await tailIdOf(toStatus, exclude).catch(() => null);

  const moved = [];
  const failed = [];
  let afterId = tailId;

  for (const id of ids) {
    try {
      await callTool('issue_move', { id, toStatus, afterId, failReason: failReason ?? '' });
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

// 统一错误处理
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[cloudissue] error:', err);
  res.status(status).json({ error: err.message || '服务器内部错误' });
});

// ------------------------------------------------------------------
// 启动：先通过 MCP 完成建表与按需初始化
// ------------------------------------------------------------------
async function start() {
  try {
    const boot = await callTool('board_bootstrap');
    console.log(
      `[cloudissue] 数据库就绪（经 MCP）：${boot.seeded ? `已写入 ${boot.count} 条示例任务` : '保留现有数据'}`
    );
  } catch (err) {
    console.error('[cloudissue] 数据库初始化失败，请检查 MySQL 连接配置（.env）：');
    console.error(`  ${err.message}`);
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`[cloudissue] 看板已启动： http://localhost:${PORT}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();
