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

/** 需要强制填写失败原因的目标状态 */
export const FAIL_STATUS = 'failed';

/** 拖入「失败」列但取消/未填写原因时的统一提示 */
export const MSG_MOVE_CANCELLED_NO_REASON = '已取消移动：未填写失败原因，任务保留在原列';
