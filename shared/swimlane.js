// 前后端共用的泳道分组规则（视图层概念，不改变数据归属）。
// 泳道 = 列内按标签或负责人分区；卡片属于哪个组由它自己的字段决定，
// 拖拽只改 status/position，落位后卡片渲染回自身组（跨组投放自动归位）。
// 该文件同时被 Node 端（ESM）与浏览器端（<script type="module">）加载，只能纯函数。

/** 泳道维度 */
export const LANE_DIMS = ['none', 'tag', 'assignee'];

/** 泳道维度的展示名（筛选栏切换器用） */
export const LANE_DIM_LABELS = {
  none: '泳道：关',
  tag: '泳道：标签',
  assignee: '泳道：负责人',
};

/**
 * 卡片在给定维度下的泳道键。
 * 标签取第一个标签（多标签卡片只归首组）；无标签/未指派用哨兵值。
 * @param {any} issue
 * @param {'none' | 'tag' | 'assignee'} dim
 * @returns {string}
 */
export function laneKeyOf(issue, dim) {
  if (dim === 'tag') {
    const first = (issue.tags || [])[0];
    return `tag:${first ? String(first) : '_none'}`;
  }
  if (dim === 'assignee') {
    return issue.assigneeId != null ? `assignee:${issue.assigneeId}` : 'assignee:_none';
  }
  return 'none';
}

/**
 * 泳道键 → 展示名。
 * @param {string} key laneKeyOf 的返回值
 * @param {(userId: number) => string | null} [resolveUser] 负责人 id → 展示名（无映射时回退文本）
 */
export function laneTitleOf(key, resolveUser) {
  const idx = key.indexOf(':');
  const kind = idx >= 0 ? key.slice(0, idx) : key;
  const val = idx >= 0 ? key.slice(idx + 1) : '';
  if (kind === 'tag') return val === '_none' ? '无标签' : `# ${val}`;
  if (kind === 'assignee') {
    if (val === '_none') return '未指派';
    const id = Number(val);
    return (resolveUser && resolveUser(id)) || `用户 ${val}`;
  }
  return '';
}
