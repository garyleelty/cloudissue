/**
 * 筛选下拉（多选）的渲染与交互。
 */
import { state, notify } from './state.js';
import { PRIORITIES, PRIORITY_LABELS, ASSIGNEE_NONE } from '../../shared/constants.js';
import { esc } from './utils.js';

const $ = (sel) => document.querySelector(sel);

/**
 * 收集某个维度的可选项
 * @param {'priority' | 'tag' | 'assignee'} kind
 * @returns {{ value: string, label: string }[]}
 */
function collectOptions(kind) {
  if (kind === 'priority') {
    return PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }));
  }
  if (kind === 'tag') {
    return [...new Set(state.issues.flatMap((i) => i.tags))]
      .sort()
      .map((t) => ({ value: t, label: `# ${t}` }));
  }
  // 负责人：以用户表为骨架（含「未指派」），再补上历史卡片的自由文本负责人
  const out = [{ value: ASSIGNEE_NONE, label: '未指派' }];
  for (const u of state.users) {
    out.push({ value: String(u.id), label: u.displayName || u.username });
  }
  for (const a of [...new Set(state.issues.filter((i) => i.assigneeId == null).map((i) => i.assignee))]) {
    if (a) out.push({ value: a, label: a });
  }
  return out;
}

/**
 * @param {HTMLElement} panel
 * @param {'priority' | 'tag' | 'assignee'} kind
 */
export function buildDropPanel(panel, kind) {
  const options = collectOptions(kind);

  if (!options.length) {
    panel.innerHTML = '<div class="drop-empty">暂无可选项</div>';
    return;
  }

  panel.innerHTML = options
    .map((o) => {
      const checked = state.filters[kind].has(o.value);
      return `
        <button class="drop-opt" type="button" role="checkbox"
                aria-checked="${checked}" data-value="${esc(o.value)}">
          <span class="drop-check">
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>
          </span>
          <span>${esc(o.label)}</span>
        </button>`;
    })
    .join('');
}

export function syncDropdowns() {
  buildDropPanel($('#panelPriority'), 'priority');
  buildDropPanel($('#panelTag'), 'tag');
  buildDropPanel($('#panelAssignee'), 'assignee');
  syncDropCounts();
}

export function syncDropCounts() {
  document.querySelectorAll('.drop-count').forEach((el) => {
    const kind = el.dataset.count;
    const n = state.filters[kind].size;
    el.textContent = n ? String(n) : '';
    el.classList.toggle('show', n > 0);
  });
}

export function closeAllDropdowns() {
  document.querySelectorAll('.dropdown').forEach((d) => {
    d.querySelector('.drop-trigger').setAttribute('aria-expanded', 'false');
    d.querySelector('.drop-panel').classList.remove('open');
  });
}

/** 绑定下拉的展开与勾选行为；筛选变化后通过 notify() 通知视图刷新 */
export function bindDropdowns() {
  document.querySelectorAll('.dropdown').forEach((dd) => {
    // 只装配筛选下拉：没有 data-filter（如看板切换器）或未知维度的跳过，
    // 否则会和该组件自己的事件处理器打架，甚至往 state.filters 里写坏维度
    const kind = dd.dataset.filter;
    if (!kind || typeof state.filters[kind]?.has !== 'function') return;

    const trigger = dd.querySelector('.drop-trigger');
    const panel = dd.querySelector('.drop-panel');

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !panel.classList.contains('open');
      closeAllDropdowns();
      if (willOpen) {
        buildDropPanel(panel, kind);
        panel.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
      }
    });

    panel.addEventListener('click', (e) => {
      e.stopPropagation();
      const opt = e.target.closest('.drop-opt');
      if (!opt) return;
      const value = opt.dataset.value;
      const set = state.filters[kind];
      if (set.has(value)) set.delete(value);
      else set.add(value);
      opt.setAttribute('aria-checked', String(set.has(value)));
      syncDropCounts();
      notify();
    });
  });
}
