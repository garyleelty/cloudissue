// 前后端共用的枚举与文案定义
// 该文件同时被 Node 端（ESM）与浏览器端（<script type="module">）加载。

/** 五列固定状态（顺序即看板列顺序） */
export const STATUSES = ['backlog', 'planning', 'in_progress', 'done', 'failed'];

/** 状态中文名 */
export const STATUS_LABELS = {
  backlog: '未规划',
  planning: '规划中',
  in_progress: '进行中',
  done: '已完成',
  failed: '失败',
};

/** 优先级（由高到低） */
export const PRIORITIES = ['high', 'medium', 'low'];

/** 优先级中文名 */
export const PRIORITY_LABELS = {
  high: '高',
  medium: '中',
  low: '低',
};

/** issue 类型 */
export const ISSUE_TYPES = ['bug', 'feature', 'task', 'chore', 'docs'];

/** issue 类型中文名与图标（icon 为纯文本，前后端共用） */
export const ISSUE_TYPE_LABELS = {
  bug: { label: 'Bug', icon: '🐞' },
  feature: { label: '需求', icon: '✨' },
  task: { label: '任务', icon: '🔧' },
  chore: { label: '杂务', icon: '🧹' },
  docs: { label: '文档', icon: '📝' },
};

/** 筛选维度里「未指派」的哨兵值（assignee_id 为空时使用） */
export const ASSIGNEE_NONE = '_none';

/** 需要强制填写失败原因的目标状态 */
export const FAIL_STATUS = 'failed';

/** 拖入「失败」列但取消/未填写原因时的统一提示 */
export const MSG_MOVE_CANCELLED_NO_REASON = '已取消移动：未填写失败原因，任务保留在原列';

/**
 * 移动端断点（px）。styles.css 的 @media (max-width: 860px) 与此对应，
 * 改动时两处必须同步（CSS 无法引用 JS 常量）。
 */
export const MOBILE_BREAKPOINT = 860;
