#!/usr/bin/env node
/**
 * CloudIssue · MCP 数据服务
 * ---------------------------------------------------------------
 * 这是整个应用中唯一直接访问 MySQL 的组件。
 * HTTP 层（server/index.js）不允许直连数据库，所有读写都必须通过
 * 这里暴露的 MCP tools 完成，从而满足「数据读写通过 MCP 能力完成」。
 *
 * 同一套 tools 有两个传输入口：
 *   · stdio（默认）—— HTTP 层内部拉起的子进程；
 *   · Streamable HTTP —— 由 server/mcp-http.js 导入 createBoardServer()，
 *     挂载在 /mcp 供外部 AI 客户端连接。
 *
 * 直接运行：node mcp-server/index.js（stdio 模式）
 * 调试：npx @modelcontextprotocol/inspector node mcp-server/index.js
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { pool, query, withTransaction, runSchema, ensureDatabase, closeDb } from './db.js';
import { STATUSES, STATUS_LABELS, PRIORITIES, ISSUE_TYPES, FAIL_STATUS } from '../shared/constants.js';

// ------------------------------------------------------------------
// 工具函数
// ------------------------------------------------------------------
const toDateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v || null);
const toIsoStr = (v) => (v instanceof Date ? v.toISOString() : v || null);

/**
 * 业务校验失败统一抛 McpError(InvalidParams)：HTTP 层据此映射 400 并把
 * message 透出给用户；非 McpError 的意外异常则按系统故障处理（5xx，不透出细节）。
 */
const bizError = (message) => new McpError(ErrorCode.InvalidParams, message);

/** 归一化标签：支持数组或逗号分隔字符串 */
function normalizeTags(input) {
  const list = Array.isArray(input)
    ? input
    : String(input || '')
        .split(/[,，\s]+/)
        .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = String(raw).trim().slice(0, 48);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/** issues 行 + 标签/日志行 → 对外 JSON 结构（fetchBoard 与 fetchIssueById 共用） */
function shapeIssue(i, tags, logs, commentCount = 0) {
  return {
    id: i.id,
    title: i.title,
    type: i.type || 'task',
    description: i.description || '',
    priority: i.priority,
    assignee: i.assignee || '',
    assigneeId: i.assignee_id == null ? null : Number(i.assignee_id),
    tags,
    dueDate: toDateStr(i.due_date),
    status: i.status,
    boardId: Number(i.board_id ?? 1),
    boardName: i.board_name || '',
    position: i.position,
    version: Number(i.version ?? 1),
    commentCount,
    createdAt: toIsoStr(i.created_at),
    updatedAt: toIsoStr(i.updated_at),
    logs,
  };
}

/** issues 与 boards 的联查片段：boardName 供多看板视图直接展示 */
const ISSUE_SELECT = `
  SELECT i.*, b.name AS board_name
    FROM issues i
    LEFT JOIN boards b ON b.id = i.board_id
`;

/** 读取看板数据（任务 + 标签 + 状态变更记录 + 评论计数）；boardId 给定时只取该看板 */
async function fetchBoard(boardId = null, conn = pool) {
  const [issues] = boardId
    ? await conn.query(`${ISSUE_SELECT} WHERE i.board_id = ? ORDER BY i.position ASC, i.id ASC`, [boardId])
    : await conn.query(`${ISSUE_SELECT} ORDER BY i.position ASC, i.id ASC`);
  if (!issues.length) return [];

  const ids = issues.map((i) => i.id);
  const placeholders = ids.map(() => '?').join(',');

  const [tagRows] = await conn.query(
    `SELECT issue_id, tag FROM issue_tags WHERE issue_id IN (${placeholders}) ORDER BY tag ASC`,
    ids,
  );
  const [logRows] = await conn.query(
    `SELECT id, issue_id, from_status, to_status, reason, actor, changed_at
       FROM issue_status_logs WHERE issue_id IN (${placeholders})
      ORDER BY changed_at ASC, id ASC`,
    ids,
  );
  const [commentRows] = await conn.query(
    `SELECT issue_id, COUNT(*) AS n FROM issue_comments
      WHERE issue_id IN (${placeholders}) GROUP BY issue_id`,
    ids,
  );

  const tagMap = new Map();
  for (const r of tagRows) {
    if (!tagMap.has(r.issue_id)) tagMap.set(r.issue_id, []);
    tagMap.get(r.issue_id).push(r.tag);
  }
  const logMap = new Map();
  for (const r of logRows) {
    if (!logMap.has(r.issue_id)) logMap.set(r.issue_id, []);
    logMap.get(r.issue_id).push({
      id: r.id,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      reason: r.reason || '',
      actor: r.actor || '',
      changedAt: toIsoStr(r.changed_at),
    });
  }
  const commentCountMap = new Map(commentRows.map((r) => [r.issue_id, Number(r.n)]));

  return issues.map((i) =>
    shapeIssue(i, tagMap.get(i.id) || [], logMap.get(i.id) || [], commentCountMap.get(i.id) || 0),
  );
}

/** boards 行 → 对外 JSON（issueCount 供切换器展示规模） */
function shapeBoard(b) {
  return {
    id: Number(b.id),
    name: b.name,
    description: b.description || '',
    issueCount: Number(b.issue_count ?? 0),
    createdAt: toIsoStr(b.created_at),
  };
}

/** 全部看板（按 position 排序，附带每个看板的任务数） */
async function fetchBoards(conn = pool) {
  const [rows] = await conn.query(
    `SELECT b.*, COUNT(i.id) AS issue_count
       FROM boards b LEFT JOIN issues i ON i.board_id = b.id
      GROUP BY b.id
      ORDER BY b.position ASC, b.id ASC`,
  );
  return rows.map(shapeBoard);
}

/** 校验看板存在；不存在抛业务错（issue_create/issue_update 的 boardId 入口共用） */
async function assertBoardExists(boardId, conn = pool) {
  const [[row]] = await conn.query('SELECT id FROM boards WHERE id = ?', [boardId]);
  if (!row) throw bizError('目标看板不存在');
}

/** 按 id 读取评论（详情抽屉 / issue_get 用） */
async function fetchComments(issueId, conn = pool) {
  const [rows] = await conn.query(
    `SELECT id, author_id, author_name, body, created_at
       FROM issue_comments WHERE issue_id = ?
      ORDER BY created_at ASC, id ASC`,
    [issueId],
  );
  return rows.map((r) => ({
    id: r.id,
    authorId: r.author_id == null ? null : Number(r.author_id),
    authorName: r.author_name || '',
    body: r.body,
    createdAt: toIsoStr(r.created_at),
  }));
}

/** 单条任务的评论数 */
async function commentCountOf(issueId, conn = pool) {
  const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM issue_comments WHERE issue_id = ?', [
    issueId,
  ]);
  return Number(n);
}

/**
 * 按 id 读取单条任务（含标签与变更记录）。
 * create/update/move 的返回值用：此前是「全表拉回再 find」，随数据量线性变慢。
 */
async function fetchIssueById(id, conn = pool) {
  const [[issue]] = await conn.query(`${ISSUE_SELECT} WHERE i.id = ?`, [id]);
  if (!issue) return null;
  const [tagRows] = await conn.query('SELECT tag FROM issue_tags WHERE issue_id = ? ORDER BY tag ASC', [id]);
  const [logRows] = await conn.query(
    `SELECT id, from_status, to_status, reason, actor, changed_at
       FROM issue_status_logs WHERE issue_id = ?
      ORDER BY changed_at ASC, id ASC`,
    [id],
  );
  return shapeIssue(
    issue,
    tagRows.map((r) => r.tag),
    logRows.map((r) => ({
      id: r.id,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      reason: r.reason || '',
      actor: r.actor || '',
      changedAt: toIsoStr(r.changed_at),
    })),
    await commentCountOf(id, conn),
  );
}

// ------------------------------------------------------------------
// 示例数据（仅在 issues 表为空时写入）
// 覆盖全部 5 个状态列与 3 个优先级
// ------------------------------------------------------------------
const SEED_TASKS = [
  {
    title: '接入企业微信机器人通知',
    type: 'feature',
    description: '任务状态流转到「已完成」时，自动推送消息到企业微信群。',
    priority: 'low',
    assignee: '林悦',
    tags: ['集成', '待评估'],
    status: 'backlog',
    dueOffset: 21,
    createdAgoDays: 9,
  },
  {
    title: '看板数据导出为 CSV',
    type: 'feature',
    description: '支持按当前筛选条件导出任务清单，便于周会同步。',
    priority: 'medium',
    assignee: '陈默',
    tags: ['导出', '工具'],
    status: 'backlog',
    dueOffset: 30,
    createdAgoDays: 7,
  },
  {
    title: '设计卡片拖拽交互规范',
    type: 'task',
    description: '明确拖拽占位、目标列高亮、非法投放反馈三种视觉状态。',
    priority: 'high',
    assignee: '苏可',
    tags: ['设计', '交互'],
    status: 'planning',
    dueOffset: 6,
    createdAgoDays: 12,
  },
  {
    title: '重构筛选器组件',
    type: 'chore',
    description: '将关键词、优先级、标签、负责人筛选收敛为一个受控组件。',
    priority: 'medium',
    assignee: '陈默',
    tags: ['前端', '重构'],
    status: 'planning',
    dueOffset: 12,
    createdAgoDays: 10,
  },
  {
    title: 'MySQL 持久化与 MCP 数据层',
    type: 'task',
    description: '建表、连接池封装，并把全部读写收敛到 MCP tools。',
    priority: 'high',
    assignee: '周野',
    tags: ['后端', '数据库', 'MCP'],
    status: 'in_progress',
    dueOffset: 2,
    createdAgoDays: 14,
  },
  {
    title: '跨列拖拽与失败原因校验',
    type: 'task',
    description: '拖入「失败」列前必须填写失败原因，否则拒绝移动并提示。',
    priority: 'high',
    assignee: '苏可',
    tags: ['前端', '交互'],
    status: 'in_progress',
    dueOffset: 3,
    createdAgoDays: 13,
  },
  {
    title: '补充空状态插画',
    type: 'feature',
    description: '为「无匹配任务」与「空看板」两种场景绘制占位插画。',
    priority: 'low',
    assignee: '林悦',
    tags: ['设计'],
    status: 'in_progress',
    dueOffset: 8,
    createdAgoDays: 5,
  },
  {
    title: '搭建前端项目骨架',
    type: 'chore',
    description: '初始化静态资源目录、样式变量与模块拆分方式。',
    priority: 'medium',
    assignee: '周野',
    tags: ['前端', '基建'],
    status: 'done',
    dueOffset: -4,
    createdAgoDays: 16,
  },
  {
    title: '统一圆角与阴影规范',
    type: 'chore',
    description: '收敛卡片、弹窗、按钮的圆角与阴影层级，贴近 Apple 设计语言。',
    priority: 'low',
    assignee: '苏可',
    tags: ['设计', '规范'],
    status: 'done',
    dueOffset: -6,
    createdAgoDays: 15,
  },
  {
    title: '接入第三方 SSO 登录',
    type: 'feature',
    description: '评估通过 OAuth 2.0 接入统一身份认证的可行性。',
    priority: 'high',
    assignee: '周野',
    tags: ['后端', '登录'],
    status: 'failed',
    dueOffset: -2,
    createdAgoDays: 18,
    failReason: '第三方服务商沙箱环境与接口文档均不可用，联调无法继续，本期暂停。',
  },
];

async function seedIfEmpty(conn) {
  const [[{ cnt }]] = await conn.query('SELECT COUNT(*) AS cnt FROM issues');
  if (Number(cnt) > 0) return { seeded: false, reason: '数据表非空，保留现有数据' };

  const now = Date.now();
  const day = 86400_000;

  for (let i = 0; i < SEED_TASKS.length; i += 1) {
    const t = SEED_TASKS[i];
    const createdAt = new Date(now - t.createdAgoDays * day + i * 37_000);
    const dueDate = new Date(now + t.dueOffset * day);

    const [res] = await conn.query(
      `INSERT INTO issues
         (title, type, description, priority, assignee, due_date, status, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.title,
        t.type || 'task',
        t.description,
        t.priority,
        t.assignee,
        toDateStr(dueDate),
        t.status,
        i,
        createdAt,
        createdAt,
      ],
    );
    const issueId = res.insertId;

    for (const tag of t.tags) {
      await conn.query('INSERT INTO issue_tags (issue_id, tag) VALUES (?, ?)', [issueId, tag]);
    }

    await conn.query(
      `INSERT INTO issue_status_logs (issue_id, from_status, to_status, reason, changed_at)
       VALUES (?, '', ?, ?, ?)`,
      [issueId, t.status, t.failReason || null, createdAt],
    );
  }

  await conn.query(
    `INSERT INTO board_meta (meta_key, meta_value) VALUES ('seeded_at', ?)
     ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)`,
    [new Date().toISOString()],
  );

  return { seeded: true, count: SEED_TASKS.length };
}

// ------------------------------------------------------------------
// MCP Server
// ------------------------------------------------------------------
/**
 * 构建看板 MCP Server 实例。
 * 两个入口复用同一套 tools：
 *   · stdio —— HTTP 层内部拉起的子进程（server/index.js 的 MCP Client）；
 *   · Streamable HTTP —— 对外暴露给 AI 客户端（server/mcp-http.js 挂载在 /mcp）。
 */
export function createBoardServer() {
  const server = new McpServer({
    name: 'cloudissue-data',
    version: '1.0.0',
  });

  const ok = (data) => ({
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  });

  const StatusEnum = z.enum(STATUSES);
  const PriorityEnum = z.enum(PRIORITIES);

  /**
   * 乐观锁：客户端把「自己看到的那份版本号」带回来，服务端比对不一致即判冲突。
   * 只在调用方显式传入 expectedVersion 时生效，老客户端不受影响。
   */
  const ExpectedVersion = z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('客户端持有的版本号；与库中不一致则判定为冲突');

  /** 冲突提示文案（前端直接展示） */
  const conflictMessage = (current, expected) =>
    `任务已被其他人修改（当前版本 v${current}，你的版本 v${expected}），请刷新后重试`;

  // 1) 健康检查
  server.registerTool('db_health', { description: '检查 MySQL 连接是否可用' }, async () => {
    const [rows] = await query('SELECT DATABASE() AS db, NOW() AS now_ts');
    return ok({ connected: true, ...rows[0], nowTs: toIsoStr(rows[0].now_ts) });
  });

  // 2) 建表 + 按需初始化示例数据
  server.registerTool(
    'board_bootstrap',
    {
      description: '执行建表脚本；仅当任务表为空时写入覆盖五列与三档优先级的示例任务',
    },
    async () => {
      await ensureDatabase();
      await runSchema();
      const seed = await withTransaction(seedIfEmpty);
      return ok({ schemaReady: true, ...seed });
    },
  );

  // 3) 读取整块看板（boardId 给定时只返回该看板，多看板视图按需拉取）
  server.registerTool(
    'issue_list',
    {
      description: '返回任务列表（含标签与状态变更记录）；传 boardId 只取该看板，不传返回全部看板的任务',
      inputSchema: { boardId: z.number().int().positive().optional().describe('只返回该看板的任务') },
    },
    async (args) => ok({ issues: await fetchBoard(args?.boardId ?? null) }),
  );

  // 3.5) 读取单条 issue（含评论全文——详情视图用）
  server.registerTool(
    'issue_get',
    {
      description: '按 id 读取单条 issue：字段、标签、变更记录与评论全文',
      inputSchema: { id: z.number().int().positive() },
    },
    async (args) => {
      const issue = await fetchIssueById(args.id);
      if (!issue) throw bizError('任务不存在或已被删除');
      return ok({ issue, comments: await fetchComments(args.id) });
    },
  );

  // 4) 新建任务
  server.registerTool(
    'issue_create',
    {
      description: '新建一个任务卡片',
      inputSchema: {
        title: z.string().min(1, '标题不能为空').max(255),
        type: z.enum(ISSUE_TYPES).optional().default('task'),
        description: z.string().max(5000).optional().default(''),
        priority: PriorityEnum.optional().default('medium'),
        assignee: z.string().max(64).optional().default(''),
        assigneeId: z.number().int().positive().nullable().optional(),
        tags: z
          .union([z.array(z.string()), z.string()])
          .optional()
          .default([]),
        dueDate: z.string().nullable().optional(),
        status: StatusEnum.optional().default('backlog'),
        boardId: z.number().int().positive().optional().default(1).describe('归属看板；缺省为默认看板'),
        failReason: z.string().optional().default(''),
        actor: z.string().max(64).optional().default(''),
      },
    },
    async (args) => {
      const status = args.status ?? 'backlog';
      if (status === FAIL_STATUS && !String(args.failReason || '').trim()) {
        throw bizError('创建到「失败」列的任务必须填写失败原因');
      }

      // 负责人必须是真实用户：解析出展示名做冗余，查无此人直接拒绝
      let assigneeName = args.assignee || '';
      if (args.assigneeId != null) {
        const [[u]] = await query('SELECT username, display_name FROM users WHERE id = ?', [args.assigneeId]);
        if (!u) throw bizError('指定的负责人用户不存在');
        assigneeName = u.display_name || u.username;
      }

      const boardId = args.boardId ?? 1;
      await assertBoardExists(boardId);

      const issue = await withTransaction(async (conn) => {
        const [[{ next }]] = await conn.query(
          'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM issues WHERE status = ? AND board_id = ?',
          [status, boardId],
        );
        const [res] = await conn.query(
          `INSERT INTO issues (title, type, description, priority, assignee, assignee_id, due_date, status, board_id, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            args.title.trim(),
            args.type || 'task',
            args.description || '',
            args.priority ?? 'medium',
            assigneeName,
            args.assigneeId ?? null,
            toDateStr(args.dueDate) || null,
            status,
            boardId,
            Number(next),
          ],
        );
        const id = res.insertId;

        for (const tag of normalizeTags(args.tags)) {
          await conn.query('INSERT INTO issue_tags (issue_id, tag) VALUES (?, ?)', [id, tag]);
        }
        await conn.query(
          `INSERT INTO issue_status_logs (issue_id, from_status, to_status, reason, actor)
           VALUES (?, '', ?, ?, ?)`,
          [id, status, status === FAIL_STATUS ? String(args.failReason).trim() : null, args.actor],
        );
        return id;
      });

      const [rows] = await pool.query(`${ISSUE_SELECT} WHERE i.id = ?`, [issue]);
      return ok({ created: true, id: issue, issue: (await fetchIssueById(issue)) ?? rows[0] });
    },
  );

  // 5) 更新任务字段
  server.registerTool(
    'issue_update',
    {
      description: '更新任务的标题、描述、优先级、负责人、标签、截止日期等字段',
      inputSchema: {
        id: z.number().int().positive(),
        title: z.string().min(1).max(255).optional(),
        type: z.enum(ISSUE_TYPES).optional(),
        description: z.string().max(5000).optional(),
        priority: PriorityEnum.optional(),
        assignee: z.string().max(64).optional(),
        assigneeId: z.number().int().positive().nullable().optional(),
        tags: z.union([z.array(z.string()), z.string()]).optional(),
        dueDate: z.string().nullable().optional(),
        status: StatusEnum.optional(),
        boardId: z.number().int().positive().optional().describe('把任务移动到另一个看板'),
        failReason: z.string().optional(),
        expectedVersion: ExpectedVersion,
        actor: z.string().max(64).optional().default(''),
      },
    },
    async (args) => {
      // 负责人变更：null=清空指派，数字=校验用户存在；名称冗余同步
      let assigneePatch = { assignee: undefined, assignee_id: undefined };
      if (args.assigneeId !== undefined) {
        if (args.assigneeId === null) {
          assigneePatch = { assignee: '', assignee_id: null };
        } else {
          const [[u]] = await query('SELECT username, display_name FROM users WHERE id = ?', [
            args.assigneeId,
          ]);
          if (!u) throw bizError('指定的负责人用户不存在');
          assigneePatch = { assignee: u.display_name || u.username, assignee_id: args.assigneeId };
        }
      }

      const updated = await withTransaction(async (conn) => {
        const [[row]] = await conn.query('SELECT * FROM issues WHERE id = ? FOR UPDATE', [args.id]);
        if (!row) throw bizError('任务不存在或已被删除');

        // 乐观并发闸门：别人已经改过这条任务，拒绝本次提交而不是静默覆盖
        if (args.expectedVersion != null && Number(row.version) !== args.expectedVersion) {
          return {
            conflict: true,
            currentVersion: Number(row.version),
            expectedVersion: args.expectedVersion,
          };
        }

        const nextStatus = args.status ?? row.status;
        const statusChanged = nextStatus !== row.status;

        if (nextStatus === FAIL_STATUS && statusChanged) {
          const reason = String(args.failReason || '').trim();
          if (!reason) throw bizError('变更为「失败」状态必须填写失败原因');
        }

        // 跨看板移动：落到目标看板同状态列的列尾；position 是「看板 × 状态」内的相对序
        let boardPatch = { board_id: row.board_id, position: row.position };
        if (args.boardId !== undefined && args.boardId !== Number(row.board_id)) {
          await assertBoardExists(args.boardId, conn);
          const [[{ next }]] = await conn.query(
            'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM issues WHERE board_id = ? AND status = ?',
            [args.boardId, nextStatus],
          );
          boardPatch = { board_id: args.boardId, position: Number(next) };
        }

        const patch = {
          title: args.title !== undefined ? args.title.trim() : row.title,
          type: args.type ?? row.type ?? 'task',
          description: args.description !== undefined ? args.description : row.description,
          priority: args.priority ?? row.priority,
          assignee: assigneePatch.assignee ?? row.assignee,
          assignee_id: assigneePatch.assignee_id !== undefined ? assigneePatch.assignee_id : row.assignee_id,
          due_date: args.dueDate !== undefined ? toDateStr(args.dueDate) : row.due_date,
          status: nextStatus,
          board_id: boardPatch.board_id,
          position: boardPatch.position,
        };

        await conn.query(
          `UPDATE issues
              SET title = ?, type = ?, description = ?, priority = ?, assignee = ?, assignee_id = ?, due_date = ?, status = ?, board_id = ?, position = ?,
                  version = version + 1
            WHERE id = ?`,
          [
            patch.title,
            patch.type,
            patch.description,
            patch.priority,
            patch.assignee,
            patch.assignee_id,
            patch.due_date,
            patch.status,
            patch.board_id,
            patch.position,
            args.id,
          ],
        );

        if (args.tags !== undefined) {
          await conn.query('DELETE FROM issue_tags WHERE issue_id = ?', [args.id]);
          for (const tag of normalizeTags(args.tags)) {
            await conn.query('INSERT INTO issue_tags (issue_id, tag) VALUES (?, ?)', [args.id, tag]);
          }
        }

        if (statusChanged) {
          await conn.query(
            `INSERT INTO issue_status_logs (issue_id, from_status, to_status, reason, actor)
             VALUES (?, ?, ?, ?, ?)`,
            [
              args.id,
              row.status,
              nextStatus,
              nextStatus === FAIL_STATUS ? String(args.failReason || '').trim() : null,
              args.actor,
            ],
          );
        }
        return { updated: true };
      });

      if (updated.conflict) {
        return ok({
          conflict: true,
          message: conflictMessage(updated.currentVersion, updated.expectedVersion),
          currentVersion: updated.currentVersion,
          issue: await fetchIssueById(args.id),
        });
      }

      return ok({ updated: true, issue: await fetchIssueById(args.id) });
    },
  );

  // 6) 移动 / 排序（跨列拖拽的核心）
  server.registerTool(
    'issue_move',
    {
      description: '把任务移动到目标状态列的指定位置；跨列时自动写入状态变更记录',
      inputSchema: {
        id: z.number().int().positive(),
        toStatus: StatusEnum,
        afterId: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe('插入到该任务之后；为空表示插到列首'),
        failReason: z.string().optional().default(''),
        expectedVersion: ExpectedVersion,
        actor: z.string().max(64).optional().default(''),
      },
    },
    async (args) => {
      const result = await withTransaction(async (conn) => {
        const [[issue]] = await conn.query('SELECT * FROM issues WHERE id = ? FOR UPDATE', [args.id]);
        if (!issue) throw bizError('任务不存在或已被删除');

        // 两人同时拖同一张卡时，后提交者被告知冲突，而不是覆盖掉前一次移动
        if (args.expectedVersion != null && Number(issue.version) !== args.expectedVersion) {
          return {
            conflict: true,
            currentVersion: Number(issue.version),
            expectedVersion: args.expectedVersion,
          };
        }

        const fromStatus = issue.status;
        const statusChanged = fromStatus !== args.toStatus;

        // 关键校验：进入「失败」列必须填写失败原因
        if (statusChanged && args.toStatus === FAIL_STATUS) {
          const reason = String(args.failReason || '').trim();
          if (!reason) throw bizError('移动到「失败」列前必须填写失败原因');
        }

        const [rows] = await conn.query(
          'SELECT id FROM issues WHERE status = ? ORDER BY position ASC, id ASC',
          [args.toStatus],
        );
        const ids = rows.map((r) => r.id).filter((x) => x !== args.id);

        let index = 0;
        if (args.afterId) {
          const found = ids.indexOf(args.afterId);
          index = found >= 0 ? found + 1 : ids.length;
        }
        ids.splice(index, 0, args.id);

        // 重新编号，保证 position 连续稳定。
        // 这里刻意不动 version：同列其他卡片只是被重排，版本号应保持稳定，
        // 否则任何一次排序都会让全列卡片的乐观锁集体失效。
        for (let i = 0; i < ids.length; i += 1) {
          await conn.query('UPDATE issues SET status = ?, position = ? WHERE id = ?', [
            args.toStatus,
            i,
            ids[i],
          ]);
        }

        // 只有被移动的这张卡版本号 +1
        const nextVersion = Number(issue.version) + 1;
        await conn.query('UPDATE issues SET version = ? WHERE id = ?', [nextVersion, args.id]);

        if (statusChanged) {
          await conn.query(
            `INSERT INTO issue_status_logs (issue_id, from_status, to_status, reason, actor)
             VALUES (?, ?, ?, ?, ?)`,
            [
              args.id,
              fromStatus,
              args.toStatus,
              args.toStatus === FAIL_STATUS ? String(args.failReason).trim() : null,
              args.actor,
            ],
          );
        }
        return { fromStatus, toStatus: args.toStatus, statusChanged, version: nextVersion };
      });

      if (result.conflict) {
        return ok({
          conflict: true,
          message: conflictMessage(result.currentVersion, result.expectedVersion),
          currentVersion: result.currentVersion,
          issue: await fetchIssueById(args.id),
        });
      }

      return ok({ moved: true, ...result });
    },
  );

  // 7) 删除任务
  server.registerTool(
    'issue_delete',
    {
      description: '删除一个任务（标签与变更记录通过外键级联删除）',
      inputSchema: { id: z.number().int().positive() },
    },
    async (args) => {
      const [res] = await query('DELETE FROM issues WHERE id = ?', [args.id]);
      if (!res.affectedRows) throw bizError('任务不存在或已被删除');
      return ok({ deleted: true, id: args.id });
    },
  );

  // 7.1) 检索：按条件过滤 issue，AI 的精准查询入口（避免拉全量）
  server.registerTool(
    'issue_search',
    {
      description:
        '按条件检索 issue：关键词（标题/描述/#编号）、状态、类型、负责人、优先级、看板；返回过滤结果与 total。找特定 issue 优先用它，而不是 issue_list 拉全量。',
      inputSchema: {
        keyword: z.string().max(255).optional().describe('标题/描述/#编号 关键词'),
        status: StatusEnum.optional(),
        type: z.enum(ISSUE_TYPES).optional(),
        assigneeId: z.number().int().positive().nullable().optional(),
        priority: PriorityEnum.optional(),
        boardId: z.number().int().positive().optional().describe('只在该看板内检索'),
        limit: z.number().int().positive().max(200).optional().default(50),
        offset: z.number().int().nonnegative().optional().default(0),
      },
    },
    async (args) => {
      let issues = await fetchBoard(args?.boardId ?? null);

      if (args.keyword) {
        const kw = args.keyword.toLowerCase();
        issues = issues.filter((i) => `#${i.id} ${i.title} ${i.description}`.toLowerCase().includes(kw));
      }
      if (args.status) issues = issues.filter((i) => i.status === args.status);
      if (args.type) issues = issues.filter((i) => (i.type || 'task') === args.type);
      if (args.priority) issues = issues.filter((i) => i.priority === args.priority);
      if (args.assigneeId !== undefined) {
        issues = issues.filter((i) =>
          args.assigneeId === null ? i.assigneeId == null : i.assigneeId === args.assigneeId,
        );
      }

      const total = issues.length;
      const slice = issues.slice(args.offset, args.offset + args.limit).map((i) => {
        const { logs, ...rest } = i;
        return { ...rest, lastChange: logs[logs.length - 1] ?? null };
      });
      return ok({ total, limit: args.limit, offset: args.offset, issues: slice });
    },
  );

  // 7.2) 评论：新增（人/AI 通用；author_name 自报身份并留名时间线）
  server.registerTool(
    'issue_comment_add',
    {
      description: '给 issue 添加一条评论；authorName 会展示给所有人（AI 客户端请自报身份）',
      inputSchema: {
        issueId: z.number().int().positive(),
        body: z.string().min(1, '评论内容不能为空').max(5000),
        authorId: z.number().int().positive().nullable().optional(),
        authorName: z.string().max(64).optional().default(''),
      },
    },
    async (args) => {
      const [[issue]] = await query('SELECT id FROM issues WHERE id = ?', [args.issueId]);
      if (!issue) throw bizError('任务不存在或已被删除');
      const [res] = await query(
        'INSERT INTO issue_comments (issue_id, author_id, author_name, body) VALUES (?, ?, ?, ?)',
        [args.issueId, args.authorId ?? null, args.authorName || '', args.body.trim()],
      );
      return ok({ created: true, id: res.insertId, comments: await fetchComments(args.issueId) });
    },
  );

  // 7.3) 评论：删除（是否允许由 HTTP 层按作者身份判定后调用）
  server.registerTool(
    'issue_comment_delete',
    {
      description: '删除一条评论（调用方需已完成作者身份校验）',
      inputSchema: {
        commentId: z.number().int().positive(),
        issueId: z.number().int().positive(),
      },
    },
    async (args) => {
      const [res] = await query('DELETE FROM issue_comments WHERE id = ? AND issue_id = ?', [
        args.commentId,
        args.issueId,
      ]);
      if (!res.affectedRows) throw bizError('评论不存在或已被删除');
      return ok({ deleted: true, comments: await fetchComments(args.issueId) });
    },
  );

  // 7.5) 看板概览：为 AI 客户端提供一次调用即可理解的紧凑快照
  server.registerTool(
    'board_summary',
    {
      description:
        '返回看板概览：全部看板清单、各列任务数、逾期与今日到期的未完成任务、高优先级未完成任务、最近 5 条状态变更。传 boardId 只统计该看板；理解看板现状请先调用它，再按需 issue_list。',
      inputSchema: { boardId: z.number().int().positive().optional().describe('只统计该看板') },
    },
    async (args) => {
      const boards = await fetchBoards();
      const issues = await fetchBoard(args?.boardId ?? null);
      const today = new Date().toISOString().slice(0, 10);
      const open = issues.filter((i) => i.status !== 'done' && i.status !== 'failed');

      const byStatus = {};
      for (const s of STATUSES) byStatus[s] = issues.filter((i) => i.status === s).length;
      const byType = {};
      for (const t of ISSUE_TYPES) byType[t] = issues.filter((i) => (i.type || 'task') === t).length;

      const overdue = open
        .filter((i) => i.dueDate && i.dueDate < today)
        .map((i) => ({ id: i.id, title: i.title, dueDate: i.dueDate, status: i.status }));
      const dueToday = open.filter((i) => i.dueDate === today).map((i) => ({ id: i.id, title: i.title }));
      const highPriority = open
        .filter((i) => i.priority === 'high')
        .map((i) => ({ id: i.id, title: i.title, status: i.status }));

      const logs = issues
        .flatMap((i) => i.logs.map((l) => ({ ...l, issueId: i.id, issueTitle: i.title })))
        .sort((a, b) => String(b.changedAt).localeCompare(String(a.changedAt)))
        .slice(0, 5)
        .map((l) => ({
          issueId: l.issueId,
          issueTitle: l.issueTitle,
          fromStatus: l.fromStatus,
          toStatus: l.toStatus,
          actor: l.actor || '',
          changedAt: l.changedAt,
        }));

      return ok({
        boards,
        total: issues.length,
        byStatus,
        byType,
        statusLabels: STATUS_LABELS,
        overdueCount: overdue.length,
        overdue,
        dueTodayCount: dueToday.length,
        dueToday,
        highPriorityOpen: highPriority,
        recentChanges: logs,
        generatedAt: new Date().toISOString(),
      });
    },
  );

  // ------------------------------------------------------------------
  // 多看板 workspace：看板本身也是数据，同一套 tools 暴露给人与 AI
  // ------------------------------------------------------------------

  // 7.6) 看板列表（切换器与 AI 发现看板的入口）
  server.registerTool('board_list', { description: '返回全部看板（id/名称/说明/任务数）' }, async () =>
    ok({ boards: await fetchBoards() }),
  );

  // 7.7) 新建看板
  server.registerTool(
    'board_create',
    {
      description: '新建一个看板（name 唯一）；新看板为空，用 issue_create 指定 boardId 往里建任务',
      inputSchema: {
        name: z.string().min(1, '看板名不能为空').max(64),
        description: z.string().max(255).optional().default(''),
        actor: z.string().max(64).optional().default(''),
      },
    },
    async (args) => {
      const name = args.name.trim();
      if (!name) throw bizError('看板名不能为空');
      try {
        const [res] = await query('INSERT INTO boards (name, description) VALUES (?, ?)', [
          name,
          args.description || '',
        ]);
        const [[row]] = await pool.query('SELECT b.*, 0 AS issue_count FROM boards b WHERE b.id = ?', [
          res.insertId,
        ]);
        return ok({ created: true, board: shapeBoard(row) });
      } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') throw bizError('同名看板已存在');
        throw err;
      }
    },
  );

  // 7.8) 删除看板（任务级联删除；最后一个看板受保护）
  server.registerTool(
    'board_delete',
    {
      description:
        '删除一个看板，其下任务连同标签/评论/变更记录一并级联删除；至少保留一个看板，删除最后一个看板会被拒绝',
      inputSchema: { id: z.number().int().positive() },
    },
    async (args) => {
      const [[board]] = await query('SELECT id, name FROM boards WHERE id = ?', [args.id]);
      if (!board) throw bizError('看板不存在或已被删除');

      const [[{ total }]] = await query('SELECT COUNT(*) AS total FROM boards');
      if (Number(total) <= 1) throw bizError('至少保留一个看板，不能删除最后一个看板');

      await query('DELETE FROM boards WHERE id = ?', [args.id]);
      return ok({ deleted: true, id: args.id, name: board.name });
    },
  );

  // ------------------------------------------------------------------
  // 用户（认证身份）。口令哈希在 HTTP 层完成，这里只负责存取。
  // ------------------------------------------------------------------

  /** users 行 → 对外 JSON（含 password_hash/api_token，仅供 HTTP 层校验，不出 HTTP↔MCP 边界） */
  function shapeUser(u) {
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name || '',
      passwordHash: u.password_hash,
      tokenVersion: Number(u.token_version ?? 0),
      apiToken: u.api_token || null,
      createdAt: toIsoStr(u.created_at),
    };
  }

  // 8) 创建用户
  server.registerTool(
    'user_create',
    {
      description: '创建一个用户（username 唯一）；apiToken 由 HTTP 层生成后传入',
      inputSchema: {
        username: z.string().min(1).max(32),
        displayName: z.string().max(64).optional().default(''),
        passwordHash: z.string().min(1).max(255),
        apiToken: z.string().max(64).nullable().optional(),
      },
    },
    async (args) => {
      try {
        const [res] = await query(
          'INSERT INTO users (username, display_name, password_hash, api_token) VALUES (?, ?, ?, ?)',
          [args.username, args.displayName, args.passwordHash, args.apiToken ?? null],
        );
        return ok({ created: true, id: res.insertId });
      } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') {
          throw bizError('用户名已被占用');
        }
        throw err;
      }
    },
  );

  // 9) 按用户名取用户（登录用）
  server.registerTool(
    'user_get_by_username',
    {
      description: '按用户名查找用户；不存在返回 user: null',
      inputSchema: { username: z.string().min(1).max(32) },
    },
    async (args) => {
      const [[row]] = await query('SELECT * FROM users WHERE username = ?', [args.username]);
      return ok({ user: row ? shapeUser(row) : null });
    },
  );

  // 9.5) 按 API Token 取用户（/mcp 的 Bearer 认证用）
  server.registerTool(
    'user_get_by_token',
    {
      description: '按 API Token 查找用户；不存在返回 user: null',
      inputSchema: { token: z.string().min(8).max(64) },
    },
    async (args) => {
      const [[row]] = await query('SELECT * FROM users WHERE api_token = ?', [args.token]);
      return ok({ user: row ? shapeUser(row) : null });
    },
  );

  // 9.5.5) 用户列表（负责人选择器等只读用途；脱敏，不含凭据字段）
  server.registerTool(
    'user_list',
    { description: '返回全部用户（id/username/displayName），供负责人选择等只读用途' },
    async () => {
      const [rows] = await query('SELECT id, username, display_name FROM users ORDER BY id ASC');
      return ok({
        users: rows.map((r) => ({
          id: Number(r.id),
          username: r.username,
          displayName: r.display_name || '',
        })),
      });
    },
  );

  // 9.6) 设置/轮换 API Token（HTTP 层生成新值后写入）
  server.registerTool(
    'user_set_api_token',
    {
      description: '写入用户的 API Token（轮换）',
      inputSchema: {
        id: z.number().int().positive(),
        apiToken: z.string().min(8).max(64),
      },
    },
    async (args) => {
      const [res] = await query('UPDATE users SET api_token = ? WHERE id = ?', [args.apiToken, args.id]);
      if (!res.affectedRows) throw bizError('用户不存在或已被删除');
      return ok({ updated: true });
    },
  );

  // 10) 按 id 取用户（鉴权中间件用：每次请求校验 token_version）
  server.registerTool(
    'user_get_by_id',
    {
      description: '按 id 查找用户；不存在返回 user: null',
      inputSchema: { id: z.number().int().positive() },
    },
    async (args) => {
      const [[row]] = await query('SELECT * FROM users WHERE id = ?', [args.id]);
      return ok({ user: row ? shapeUser(row) : null });
    },
  );

  // 11) 吊销版本号 +1（修改密码后使所有旧 JWT 失效）
  server.registerTool(
    'user_bump_token_version',
    {
      description: '把用户的 token_version +1，返回新版本号',
      inputSchema: { id: z.number().int().positive() },
    },
    async (args) => {
      const [res] = await query('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [args.id]);
      if (!res.affectedRows) throw bizError('用户不存在或已被删除');
      const [[{ v }]] = await query('SELECT token_version AS v FROM users WHERE id = ?', [args.id]);
      return ok({ tokenVersion: Number(v) });
    },
  );

  // 12) 更新口令哈希（可选同时 bump token_version，同一事务内保证一致）
  server.registerTool(
    'user_update_auth',
    {
      description: '更新用户口令哈希；bumpTokenVersion 为真时同步 +1 吊销旧会话',
      inputSchema: {
        id: z.number().int().positive(),
        passwordHash: z.string().min(1).max(255),
        bumpTokenVersion: z.boolean().optional().default(false),
      },
    },
    async (args) => {
      const { tokenVersion } = await withTransaction(async (conn) => {
        const [res] = await conn.query(
          args.bumpTokenVersion
            ? 'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?'
            : 'UPDATE users SET password_hash = ? WHERE id = ?',
          args.bumpTokenVersion ? [args.passwordHash, args.id] : [args.passwordHash, args.id],
        );
        if (!res.affectedRows) throw bizError('用户不存在或已被删除');
        const [[row]] = await conn.query('SELECT token_version AS tv FROM users WHERE id = ?', [args.id]);
        return { tokenVersion: Number(row.tv) };
      });
      return ok({ updated: true, tokenVersion });
    },
  );

  // ------------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------------

  return server;
}

async function main() {
  const server = createBoardServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 注意：诊断日志只能写 stderr，stdout 被 MCP 协议占用
  console.error('[cloudissue-mcp] data server ready (stdio)');

  // HTTP 层优雅停机会 close() MCP client → stdin 关闭。
  // 此时清空连接池并退出，避免子进程因持有池连接而僵死。
  process.stdin.on('end', () => {
    console.error('[cloudissue-mcp] stdin closed, shutting down');
    closeDb().finally(() => process.exit(0));
  });
  process.stdin.resume();
}

// 仅直接运行（stdio 模式）时才注册 stdio 入口与进程级兜底：
// 被 server/mcp-http.js import 时，进程级策略归 HTTP 层管，这里绝不能抢
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  // 兜底：意外异常直接退出（crash-only），由 HTTP 层的重连机制恢复
  process.on('uncaughtException', (err) => {
    console.error('[cloudissue-mcp] uncaughtException:', err);
    closeDb().finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (err) => {
    console.error('[cloudissue-mcp] unhandledRejection:', err);
  });

  main().catch((err) => {
    console.error('[cloudissue-mcp] fatal:', err);
    process.exit(1);
  });
}
