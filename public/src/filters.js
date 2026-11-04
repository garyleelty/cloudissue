/**
 * 筛选逻辑：纯函数，只依赖传入的 issue 与筛选条件。
 * 组合规则：同一维度内 OR，不同维度之间 AND。
 */
import { state } from './state.js';
import { ASSIGNEE_NONE, AI_ACTOR_PREFIX } from '../../shared/constants.js';

/** issue 的负责人筛选键：有关联用户取 id，否则旧文本，未指派取哨兵值 */
export function assigneeKey(issue) {
  if (issue.assigneeId != null) return String(issue.assigneeId);
  return issue.assignee || ASSIGNEE_NONE;
}

/** @param {any} issue @param {BoardState['filters']} f @returns {boolean} */
export function matchesFilters(issue, f) {
  if (f.keyword) {
    const kw = f.keyword.toLowerCase();
    const hay = `#${issue.id} ${issue.title} ${issue.description}`.toLowerCase();
    if (!hay.includes(kw)) return false;
  }
  if (f.priority.size && !f.priority.has(issue.priority)) return false;
  if (f.assignee.size && !f.assignee.has(assigneeKey(issue))) return false;
  if (f.tag.size && !issue.tags.some((t) => f.tag.has(t))) return false;
  if (f.aiOnly && !isAiTouched(issue)) return false;
  return true;
}

/** 是否有 AI 操作者在这张卡上留过痕（actor 以 ai: 开头） */
export function isAiTouched(issue) {
  return issue.logs.some((l) => (l.actor || '').startsWith(AI_ACTOR_PREFIX));
}

/** @returns {any[]} */
export function filteredIssues() {
  return state.issues.filter((i) => matchesFilters(i, state.filters));
}

/** @returns {boolean} */
export function hasActiveFilters() {
  const f = state.filters;
  return Boolean(f.keyword) || f.priority.size > 0 || f.tag.size > 0 || f.assignee.size > 0 || f.aiOnly;
}
