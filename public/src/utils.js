/**
 * 纯工具函数：无 DOM 依赖、无副作用，便于单独测试。
 */

const ESC_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** HTML 转义：所有用户内容渲染前必须经过它，防止结构破坏与脚本注入 */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

const pad = (n) => String(n).padStart(2, '0');

/** 格式化为 `YYYY-MM-DD HH:mm`；非法值返回占位符 */
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** 距离今天的天数（忽略时分秒）；无法解析返回 null */
export function daysFromToday(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  return Math.round((target - today) / 86400000);
}

/** 根据截止日期返回 { text, cls }，已完成的任务不参与逾期判定 */
export function dueInfo(issue) {
  if (!issue.dueDate) return { text: '无期限', cls: '' };
  const days = daysFromToday(issue.dueDate);
  if (days === null) return { text: issue.dueDate, cls: '' };

  let cls = '';
  if (issue.status !== 'done') {
    if (days < 0) cls = ' overdue';
    else if (days <= 3) cls = ' soon';
  }

  let text = issue.dueDate;
  if (days < 0) text = `逾期 ${Math.abs(days)} 天`;
  else if (days === 0) text = '今天到期';

  return { text, cls };
}
