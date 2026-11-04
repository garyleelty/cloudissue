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
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { logger } from './logger.js';
import { callTool, closeMcp } from './mcp-client.js';
import { authRouter, authRequired } from './auth.js';
import { mcpHttpRouter, authByToken } from './mcp-http.js';
import { STATUSES, STATUS_LABELS, PRIORITY_LABELS, ISSUE_TYPE_LABELS } from '../shared/constants.js';
import { matchesFilters, parseExportFilters } from '../shared/issue-filters.js';
import { toCsv, CSV_BOM } from '../shared/csv.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, '..');

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

/** 环境变量 fail-fast 校验：配置错误应让进程立刻退出 */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().max(65535).default(5173),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_RATE_LIMIT: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),
});
const parsedEnv = EnvSchema.safeParse(process.env);
if (!parsedEnv.success) {
  for (const issue of parsedEnv.error.issues) {
    console.error(`[cloudissue] 环境变量错误 ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}
const { PORT, API_RATE_LIMIT, AUTH_RATE_LIMIT } = parsedEnv.data;

// ------------------------------------------------------------------
// Express 应用
// ------------------------------------------------------------------
const app = express();

// 安全头。本应用同源部署：CSP 允许 self 脚本/样式 + data: 图标
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// 反向代理部署时设 TRUST_PROXY=true，限流才能按真实客户端 IP 计数
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

// 请求日志（含 requestId，错误中间件会回带）
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
});

// 共享枚举常量直接以 ESM 形式提供给前端，避免前后端文案不一致
app.use('/shared', express.static(path.join(PROJECT_ROOT, 'shared')));
app.use(express.static(path.join(PROJECT_ROOT, 'public')));

// 限流：全局 API 从宽、认证入口从严（防爆破/防撞库）。
// 集成测试与 CI 通过 AUTH_RATE_LIMIT/API_RATE_LIMIT 调高阈值。
const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: API_RATE_LIMIT,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: AUTH_RATE_LIMIT,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: '尝试次数过多，请 15 分钟后再试' },
});

app.use('/api', apiLimiter);
app.use('/api/auth', authLimiter, authRouter);

// AI/MCP 客户端入口：Bearer API Token 认证 + 无状态 Streamable HTTP
app.use('/mcp', apiLimiter, authByToken, mcpHttpRouter);

// 业务接口一律先过鉴权（/api/health 保持公开，供容器 healthcheck）
app.use('/api/issues', authRequired);
app.use('/api/users', authRequired);
app.use('/api/comments', authRequired);
app.use('/api/boards', authRequired);

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

/** 健康检查：确认 MCP 链路与数据库均可用 */
app.get(
  '/api/health',
  asyncHandler(async (_req, res) => {
    const info = await callTool('db_health');
    res.json({ ok: true, viaMcp: true, ...info });
  }),
);

/** boardId 查询参数归一化：缺省/非法返回 null（null = 全部看板） */
function boardIdOf(req) {
  const raw = req.query.boardId;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** 获取任务列表：?boardId= 只取该看板，缺省返回全部看板的任务 */
app.get(
  '/api/issues',
  asyncHandler(async (req, res) => {
    const boardId = boardIdOf(req);
    if (boardId === undefined) return res.status(400).json({ error: '非法的看板 ID' });
    const data = await callTool('issue_list', boardId ? { boardId } : {});
    res.json(data);
  }),
);

/** 看板列表（多看板切换器与 AI 发现入口） */
app.get(
  '/api/boards',
  asyncHandler(async (_req, res) => {
    const data = await callTool('board_list');
    res.json(data);
  }),
);

/** 新建看板 */
app.post(
  '/api/boards',
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: '看板名不能为空' });
    if (name.length > 64) return res.status(400).json({ error: '看板名最长 64 字' });
    const description = String(req.body?.description || '').trim();
    if (description.length > 255) return res.status(400).json({ error: '看板说明最长 255 字' });

    const data = await callTool('board_create', {
      name,
      description,
      actor: req.user.username,
    });
    res.status(201).json(data);
  }),
);

/** 删除看板：其下任务级联删除，最后一个看板受保护（校验在 MCP 内） */
app.delete(
  '/api/boards/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: '非法的看板 ID' });
    }
    const data = await callTool('board_delete', { id });
    res.json(data);
  }),
);

// 看板成员与角色：护栏在 MCP 数据层（人与 AI 同受约束），这里只做转发
app.get(
  '/api/boards/:id/members',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法的看板 ID' });
    const data = await callTool('member_list', { boardId: id });
    res.json(data);
  }),
);

app.post(
  '/api/boards/:id/members',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法的看板 ID' });
    const userId = Number(req.body?.userId);
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: '非法的用户 ID' });
    const role = req.body?.role ?? 'member';
    if (!['owner', 'member', 'viewer'].includes(role)) {
      return res.status(400).json({ error: '非法的角色' });
    }
    const data = await callTool('member_add', { boardId: id, userId, role });
    res.status(201).json(data);
  }),
);

app.delete(
  '/api/boards/:id/members/:userId',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const userId = Number(req.params.userId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: '非法的 ID' });
    }
    const data = await callTool('member_remove', { boardId: id, userId });
    res.json(data);
  }),
);

/**
 * 导出 CSV：按当前筛选条件导出 issue 清单。
 * 数据经 MCP 的 issue_list 拉取（不在 HTTP 层碰 SQL）；
 * 过滤复用 shared/issue-filters.js——与 Web 端看板同一份口径，所见即所得。
 * 排序与看板一致：按五列顺序 + 列内位置。
 */
app.get(
  '/api/export/csv',
  authRequired,
  asyncHandler(async (req, res) => {
    const boardId = boardIdOf(req);
    if (boardId === undefined) return res.status(400).json({ error: '非法的看板 ID' });

    const { issues = [] } = await callTool('issue_list', boardId ? { boardId } : {});
    const filters = parseExportFilters(req.query);
    const statusRank = Object.fromEntries(STATUSES.map((s, i) => [s, i]));
    const rows = issues
      .filter((i) => matchesFilters(i, filters))
      .sort(
        (a, b) =>
          (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) || (a.position ?? 0) - (b.position ?? 0),
      );

    const table = [
      [
        '#编号',
        '标题',
        '类型',
        '状态',
        '优先级',
        '负责人',
        '标签',
        '截止日期',
        '评论数',
        '描述',
        '创建时间',
        '更新时间',
      ],
      ...rows.map((i) => [
        i.id,
        i.title,
        ISSUE_TYPE_LABELS[i.type]?.label || i.type || '任务',
        STATUS_LABELS[i.status] || i.status,
        `${PRIORITY_LABELS[i.priority] || i.priority}优先级`,
        i.assignee || '未指派',
        (i.tags || []).join(' '),
        i.dueDate || '',
        i.commentCount ?? 0,
        i.description || '',
        i.createdAt || '',
        i.updatedAt || '',
      ]),
    ];

    const boardName = rows[0]?.boardName || (boardId ? `看板${boardId}` : '全部看板');
    const filename = `cloudissue-${boardName}-${new Date().toISOString().slice(0, 10)}.csv`;
    // filename 只放 ASCII 兜底；中文文件名走 RFC 5987 的 filename*
    const asciiName = `cloudissue-export-${boardId || 'all'}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('X-Export-Count', String(rows.length));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.send(CSV_BOM + toCsv(table));
  }),
);

/** 用户列表（负责人选择器等只读用途） */
app.get(
  '/api/users',
  asyncHandler(async (_req, res) => {
    const data = await callTool('user_list');
    res.json(data);
  }),
);

/** issue 详情（字段 + 评论全文） */
app.get(
  '/api/issues/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: '非法的任务 ID' });
    }
    const data = await callTool('issue_get', { id });
    res.json(data);
  }),
);

/** 添加评论 */
app.post(
  '/api/issues/:id/comments',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: '非法的任务 ID' });
    }
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: '评论内容不能为空' });
    if (body.length > 5000) return res.status(400).json({ error: '评论最长 5000 字' });

    const data = await callTool('issue_comment_add', {
      issueId: id,
      body,
      authorId: req.user.id,
      authorName: req.user.displayName || req.user.username,
    });
    res.status(201).json(data);
  }),
);

/** 删除评论：仅作者本人 */
app.delete(
  '/api/comments/:id',
  asyncHandler(async (req, res) => {
    const commentId = Number(req.params.id);
    const issueId = Number(req.query.issueId);
    if (!Number.isInteger(commentId) || commentId <= 0 || !Number.isInteger(issueId) || issueId <= 0) {
      return res.status(400).json({ error: '非法的评论 ID' });
    }
    const detail = await callTool('issue_get', { id: issueId });
    const target = (detail.comments || []).find((c) => c.id === commentId);
    if (!target) return res.status(404).json({ error: '评论不存在或已被删除' });
    if (target.authorId !== req.user.id) {
      return res.status(403).json({ error: '只能删除自己的评论' });
    }
    const data = await callTool('issue_comment_delete', { commentId, issueId });
    res.json(data);
  }),
);

/** 新建任务 */
app.post(
  '/api/issues',
  asyncHandler(async (req, res) => {
    // actor 记录操作者：人在时间线里能看到是谁（含 AI 客户端自报身份）做的变更
    const data = await callTool('issue_create', {
      ...(req.body || {}),
      actor: req.user.username,
    });
    res.status(201).json(data);
  }),
);

/** 乐观锁冲突：MCP 返回 conflict 时统一映射为 409（校验仍留在 MCP 内） */
const conflictResponse = (res, data) =>
  res.status(409).json({
    error: data.message || '任务已被其他人修改，请刷新后重试',
    conflict: true,
    currentVersion: data.currentVersion,
    issue: data.issue,
  });

/** 更新任务字段 */
app.put(
  '/api/issues/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: '非法的任务 ID' });
    }
    const data = await callTool('issue_update', {
      ...(req.body || {}),
      id,
      actor: req.user.username,
    });
    if (data.conflict) return conflictResponse(res, data);
    res.json(data);
  }),
);

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
app.post(
  '/api/issues/batch/move',
  asyncHandler(async (req, res) => {
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
        const data = await callTool('issue_move', {
          id,
          toStatus,
          afterId,
          failReason: failReason ?? '',
          expectedVersion,
          actor: req.user.username,
        });
        // 冲突不是异常：MCP 以正常结果返回 conflict，需单独归入 failed
        if (data.conflict) {
          failed.push({ id, error: data.message || '任务已被其他人修改，请刷新后重试' });
          continue;
        }
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
  }),
);

/** 批量删除 */
app.post(
  '/api/issues/batch/delete',
  asyncHandler(async (req, res) => {
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
  }),
);

/** 移动 / 排序 */
app.post(
  '/api/issues/:id/move',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: '非法的任务 ID' });
    }
    const data = await callTool('issue_move', {
      ...(req.body || {}),
      id,
      actor: req.user.username,
    });
    if (data.conflict) return conflictResponse(res, data);
    res.json(data);
  }),
);

/** 删除任务 */
app.delete(
  '/api/issues/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: '非法的任务 ID' });
    }
    const data = await callTool('issue_delete', { id });
    res.json(data);
  }),
);

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
        : '数据库就绪（经 MCP）：保留现有数据',
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
      await closeMcp();
      process.exit(0);
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
