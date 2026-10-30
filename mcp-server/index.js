#!/usr/bin/env node
/**
 * CloudIssue · MCP 数据服务
 * ---------------------------------------------------------------
 * 这是整个应用中唯一直接访问 MySQL 的组件。
 * HTTP 层（server/index.js）不允许直连数据库，所有读写都必须通过
 * 这里暴露的 MCP tools 完成，从而满足「数据读写通过 MCP 能力完成」。
 *
 * 传输方式：stdio（标准 MCP 传输协议）
 * 启动方式：node mcp-server/index.js
 * 调试方式：npx @modelcontextprotocol/inspector node mcp-server/index.js
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { pool, query, withTransaction, runSchema } from './db.js';
import { STATUSES, PRIORITIES, FAIL_STATUS } from '../shared/constants.js';

// ------------------------------------------------------------------
// 工具函数
// ------------------------------------------------------------------
const toDateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v || null);
const toIsoStr = (v) => (v instanceof Date ? v.toISOString() : v || null);

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

/** 读取整块看板数据（任务 + 标签 + 状态变更记录） */
async function fetchBoard(conn = pool) {
  const [issues] = await conn.query(
    'SELECT * FROM issues ORDER BY position ASC, id ASC'
  );
  if (!issues.length) return [];

  const ids = issues.map((i) => i.id);
  const placeholders = ids.map(() => '?').join(',');

  const [tagRows] = await conn.query(
    `SELECT issue_id, tag FROM issue_tags WHERE issue_id IN (${placeholders}) ORDER BY tag ASC`,
    ids
  );
  const [logRows] = await conn.query(
    `SELECT id, issue_id, from_status, to_status, reason, changed_at
       FROM issue_status_logs WHERE issue_id IN (${placeholders})
      ORDER BY changed_at ASC, id ASC`,
    ids
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
      changedAt: toIsoStr(r.changed_at),
    });
  }

  return issues.map((i) => ({
    id: i.id,
    title: i.title,
    description: i.description || '',
    priority: i.priority,
    assignee: i.assignee || '',
    tags: tagMap.get(i.id) || [],
    dueDate: toDateStr(i.due_date),
    status: i.status,
    position: i.position,
    createdAt: toIsoStr(i.created_at),
    updatedAt: toIsoStr(i.updated_at),
    logs: logMap.get(i.id) || [],
  }));
}

// ------------------------------------------------------------------
// 示例数据（仅在 issues 表为空时写入）
// 覆盖全部 5 个状态列与 3 个优先级
// ------------------------------------------------------------------
const SEED_TASKS = [
  {
    title: '接入企业微信机器人通知',
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
         (title, description, priority, assignee, due_date, status, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.title,
        t.description,
        t.priority,
        t.assignee,
        toDateStr(dueDate),
        t.status,
        i,
        createdAt,
        createdAt,
      ]
    );
    const issueId = res.insertId;

    for (const tag of t.tags) {
      await conn.query('INSERT INTO issue_tags (issue_id, tag) VALUES (?, ?)', [issueId, tag]);
    }

    await conn.query(
      `INSERT INTO issue_status_logs (issue_id, from_status, to_status, reason, changed_at)
       VALUES (?, '', ?, ?, ?)`,
      [issueId, t.status, t.failReason || null, createdAt]
    );
  }

  await conn.query(
    `INSERT INTO board_meta (meta_key, meta_value) VALUES ('seeded_at', ?)
     ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)`,
    [new Date().toISOString()]
  );

  return { seeded: true, count: SEED_TASKS.length };
}

// ------------------------------------------------------------------
// MCP Server
// ------------------------------------------------------------------
const server = new McpServer({
  name: 'cloudissue-data',
  version: '1.0.0',
});

const ok = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

const StatusEnum = z.enum(STATUSES);
const PriorityEnum = z.enum(PRIORITIES);

// 1) 健康检查
server.registerTool(
  'db_health',
  { description: '检查 MySQL 连接是否可用' },
  async () => {
    const [rows] = await query('SELECT DATABASE() AS db, NOW() AS now_ts');
    return ok({ connected: true, ...rows[0], nowTs: toIsoStr(rows[0].now_ts) });
  }
);

// 2) 建表 + 按需初始化示例数据
server.registerTool(
  'board_bootstrap',
  {
    description:
      '执行建表脚本；仅当任务表为空时写入覆盖五列与三档优先级的示例任务',
  },
  async () => {
    await runSchema();
    const seed = await withTransaction(seedIfEmpty);
    return ok({ schemaReady: true, ...seed });
  }
);

// 3) 读取整块看板
server.registerTool(
  'issue_list',
  { description: '返回全部任务（含标签与状态变更记录）' },
  async () => ok({ issues: await fetchBoard() })
);

// 4) 新建任务
server.registerTool(
  'issue_create',
  {
    description: '新建一个任务卡片',
    inputSchema: {
    title: z.string().min(1, '标题不能为空').max(255),
    description: z.string().max(5000).optional().default(''),
    priority: PriorityEnum.optional().default('medium'),
    assignee: z.string().max(64).optional().default(''),
    tags: z.union([z.array(z.string()), z.string()]).optional().default([]),
    dueDate: z.string().nullable().optional(),
      status: StatusEnum.optional().default('backlog'),
      failReason: z.string().optional().default(''),
    },
  },
  async (args) => {
    const status = args.status ?? 'backlog';
    if (status === FAIL_STATUS && !String(args.failReason || '').trim()) {
      throw new Error('创建到「失败」列的任务必须填写失败原因');
    }

    const issue = await withTransaction(async (conn) => {
      const [[{ next }]] = await conn.query(
        'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM issues WHERE status = ?',
        [status]
      );
      const [res] = await conn.query(
        `INSERT INTO issues (title, description, priority, assignee, due_date, status, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          args.title.trim(),
          args.description || '',
          args.priority ?? 'medium',
          args.assignee || '',
          toDateStr(args.dueDate) || null,
          status,
          Number(next),
        ]
      );
      const id = res.insertId;

      for (const tag of normalizeTags(args.tags)) {
        await conn.query('INSERT INTO issue_tags (issue_id, tag) VALUES (?, ?)', [id, tag]);
      }
      await conn.query(
        `INSERT INTO issue_status_logs (issue_id, from_status, to_status, reason)
         VALUES (?, '', ?, ?)`,
        [id, status, status === FAIL_STATUS ? String(args.failReason).trim() : null]
      );
      return id;
    });

    const [rows] = await pool.query('SELECT * FROM issues WHERE id = ?', [issue]);
    return ok({ created: true, id: issue, issue: (await fetchBoard()).find((i) => i.id === issue) ?? rows[0] });
  }
);

// 5) 更新任务字段
server.registerTool(
  'issue_update',
  {
    description: '更新任务的标题、描述、优先级、负责人、标签、截止日期等字段',
    inputSchema: {
      id: z.number().int().positive(),
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(5000).optional(),
    priority: PriorityEnum.optional(),
    assignee: z.string().max(64).optional(),
    tags: z.union([z.array(z.string()), z.string()]).optional(),
    dueDate: z.string().nullable().optional(),
    status: StatusEnum.optional(),
      failReason: z.string().optional(),
    },
  },
  async (args) => {
    const updated = await withTransaction(async (conn) => {
      const [[row]] = await conn.query('SELECT * FROM issues WHERE id = ? FOR UPDATE', [args.id]);
      if (!row) throw new Error('任务不存在或已被删除');

      const nextStatus = args.status ?? row.status;
      const statusChanged = nextStatus !== row.status;

      if (nextStatus === FAIL_STATUS && statusChanged) {
        const reason = String(args.failReason || '').trim();
        if (!reason) throw new Error('变更为「失败」状态必须填写失败原因');
      }

      const patch = {
        title: args.title !== undefined ? args.title.trim() : row.title,
        description: args.description !== undefined ? args.description : row.description,
        priority: args.priority ?? row.priority,
        assignee: args.assignee !== undefined ? args.assignee : row.assignee,
        due_date: args.dueDate !== undefined ? toDateStr(args.dueDate) : row.due_date,
        status: nextStatus,
      };

      await conn.query(
        `UPDATE issues
            SET title = ?, description = ?, priority = ?, assignee = ?, due_date = ?, status = ?
          WHERE id = ?`,
        [patch.title, patch.description, patch.priority, patch.assignee, patch.due_date, patch.status, args.id]
      );

      if (args.tags !== undefined) {
        await conn.query('DELETE FROM issue_tags WHERE issue_id = ?', [args.id]);
        for (const tag of normalizeTags(args.tags)) {
          await conn.query('INSERT INTO issue_tags (issue_id, tag) VALUES (?, ?)', [args.id, tag]);
        }
      }

      if (statusChanged) {
        await conn.query(
          `INSERT INTO issue_status_logs (issue_id, from_status, to_status, reason)
           VALUES (?, ?, ?, ?)`,
          [
            args.id,
            row.status,
            nextStatus,
            nextStatus === FAIL_STATUS ? String(args.failReason || '').trim() : null,
          ]
        );
      }
      return true;
    });

    return ok({ updated, issue: (await fetchBoard()).find((i) => i.id === args.id) });
  }
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
    },
  },
  async (args) => {
    const result = await withTransaction(async (conn) => {
      const [[issue]] = await conn.query('SELECT * FROM issues WHERE id = ? FOR UPDATE', [args.id]);
      if (!issue) throw new Error('任务不存在或已被删除');

      const fromStatus = issue.status;
      const statusChanged = fromStatus !== args.toStatus;

      // 关键校验：进入「失败」列必须填写失败原因
      if (statusChanged && args.toStatus === FAIL_STATUS) {
        const reason = String(args.failReason || '').trim();
        if (!reason) throw new Error('移动到「失败」列前必须填写失败原因');
      }

      const [rows] = await conn.query(
        'SELECT id FROM issues WHERE status = ? ORDER BY position ASC, id ASC',
        [args.toStatus]
      );
      const ids = rows.map((r) => r.id).filter((x) => x !== args.id);

      let index = 0;
      if (args.afterId) {
        const found = ids.indexOf(args.afterId);
        index = found >= 0 ? found + 1 : ids.length;
      }
      ids.splice(index, 0, args.id);

      // 重新编号，保证 position 连续稳定
      for (let i = 0; i < ids.length; i += 1) {
        await conn.query('UPDATE issues SET status = ?, position = ? WHERE id = ?', [
          args.toStatus,
          i,
          ids[i],
        ]);
      }

      if (statusChanged) {
        await conn.query(
          `INSERT INTO issue_status_logs (issue_id, from_status, to_status, reason)
           VALUES (?, ?, ?, ?)`,
          [
            args.id,
            fromStatus,
            args.toStatus,
            args.toStatus === FAIL_STATUS ? String(args.failReason).trim() : null,
          ]
        );
      }
      return { fromStatus, toStatus: args.toStatus, statusChanged };
    });

    return ok({ moved: true, ...result });
  }
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
    if (!res.affectedRows) throw new Error('任务不存在或已被删除');
    return ok({ deleted: true, id: args.id });
  }
);

// ------------------------------------------------------------------
// 启动
// ------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 注意：诊断日志只能写 stderr，stdout 被 MCP 协议占用
  console.error('[cloudissue-mcp] data server ready (stdio)');
}

main().catch((err) => {
  console.error('[cloudissue-mcp] fatal:', err);
  process.exit(1);
});
