/**
 * 筛选逻辑：视图层的薄封装。匹配规则本体在 shared/issue-filters.js
 * （与 /api/export/csv 共用同一份口径，改动规则两边同时生效）。
 */
import { state } from './state.js';
import { matchesFilters } from '../../shared/issue-filters.js';

export { assigneeKey, isAiTouched, matchesFilters } from '../../shared/issue-filters.js';

/** @returns {any[]} */
export function filteredIssues() {
  return state.issues.filter((i) => matchesFilters(i, state.filters));
}

/** @returns {boolean} */
export function hasActiveFilters() {
  const f = state.filters;
  return Boolean(f.keyword) || f.priority.size > 0 || f.tag.size > 0 || f.assignee.size > 0 || f.aiOnly;
}
