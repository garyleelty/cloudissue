// 前后端共用的 issue 筛选匹配规则（单一口径）：
//   · Web 端 filters.js 用它过滤看板 / 列表视图；
//   · 服务端 GET /api/export/csv 用它过滤导出清单。
// 两端语义必须完全一致，改动任何一条规则都直接体现在两侧。
// 该文件同时被 Node 端（ESM）与浏览器端（<script type="module">）加载，
// 只能是纯函数——不允许依赖 state / DOM / fetch。

import { ASSIGNEE_NONE, AI_ACTOR_PREFIX } from './constants.js';

/** issue 的负责人筛选键：有关联用户取 id，否则旧文本，未指派取哨兵值 */
export function assigneeKey(issue) {
  if (issue.assigneeId != null) return String(issue.assigneeId);
  return issue.assignee || ASSIGNEE_NONE;
}

/** 是否有 AI 操作者在这张卡上留过痕（actor 以 ai: 开头） */
export function isAiTouched(issue) {
  return (issue.logs || []).some((l) => (l.actor || '').startsWith(AI_ACTOR_PREFIX));
}

/**
 * 组合规则：同一维度内 OR，不同维度之间 AND。
 * @param {any} issue
 * @param {{ keyword?: string, priority?: Set<string>, tag?: Set<string>, assignee?: Set<string>, aiOnly?: boolean }} f
 * @returns {boolean}
 */
export function matchesFilters(issue, f) {
  if (f.keyword) {
    const kw = f.keyword.toLowerCase();
    const hay = `#${issue.id} ${issue.title} ${issue.description}`.toLowerCase();
    if (!hay.includes(kw)) return false;
  }
  if (f.priority && f.priority.size && !f.priority.has(issue.priority)) return false;
  if (f.assignee && f.assignee.size && !f.assignee.has(assigneeKey(issue))) return false;
  if (f.tag && f.tag.size && !(issue.tags || []).some((t) => f.tag.has(t))) return false;
  if (f.aiOnly && !isAiTouched(issue)) return false;
  return true;
}

/**
 * 把 HTTP 查询参数解析成与 Web 端一致的筛选对象。
 * 约定：q=关键词；priority/tag/assignee=逗号分隔多选；aiOnly=1|true。
 * 未知参数一律忽略；非法输入退化为「不过滤」而不是抛错（导出宁可多给）。
 * @param {URLSearchParams | Record<string, string | string[] | undefined>} query
 */
export function parseExportFilters(query) {
  const get = (key) => {
    if (query instanceof URLSearchParams) return query.get(key) || '';
    const v = query[key];
    return Array.isArray(v) ? v[0] || '' : v || '';
  };
  const set = (key) =>
    new Set(
      get(key)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  const aiOnly = get('aiOnly');
  return {
    keyword: get('q').trim(),
    priority: set('priority'),
    tag: set('tag'),
    assignee: set('assignee'),
    aiOnly: aiOnly === '1' || aiOnly === 'true',
  };
}
