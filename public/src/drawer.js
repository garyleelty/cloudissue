/**
 * issue 详情抽屉：点卡片标题从右侧滑出，展示字段、评论与活动时间线。
 * 抽屉内容低频访问，直接全量重绘（不做 DOM diff）。
 * 数据源：api.detail(id) 拉取 issue + comments；打开期间 load() 刷新看板时同步刷新。
 */
import { state } from './state.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { esc, fmtDateTime, dueInfo } from './utils.js';
import {
  STATUS_LABELS,
  PRIORITY_LABELS,
  ISSUE_TYPE_LABELS,
  AI_ACTOR_PREFIX,
} from '../../shared/constants.js';

const $ = (sel) => document.querySelector(sel);
let root;
let drawer;
let currentIssueId = null;

export function initDrawer() {
  root = $('#drawerRoot');
  drawer = root.querySelector('.drawer');

  // 遮罩点击关闭
  root.querySelector('.drawer-mask').addEventListener('click', closeDrawer);

  // 抽屉内事件委托：编辑 / 关闭 / 评论增删
  drawer.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-drawer-act]');
    if (!btn) return;
    const act = btn.dataset.drawerAct;

    if (act === 'close') return closeDrawer();
    if (act === 'edit') {
      const issue = state.issues.find((i) => i.id === currentIssueId);
      if (!issue) return;
      const { onEdit } = drawerCallbacks;
      closeDrawer();
      onEdit?.(issue);
      return;
    }
    if (act === 'del-comment') {
      const cid = Number(btn.dataset.id);
      try {
        await api.deleteComment(cid, currentIssueId);
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }
  });

  // 评论提交（Ctrl/⌘ + Enter 快捷发送）
  drawer.addEventListener('submit', async (e) => {
    const form = e.target.closest('#commentForm');
    if (!form) return;
    e.preventDefault();
    const input = form.querySelector('[name="body"]');
    const body = input.value.trim();
    if (!body) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api.addComment(currentIssueId, body);
      input.value = '';
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  drawer.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    const form = e.target.closest('#commentForm');
    if (!form) return;
    e.preventDefault();
    form.requestSubmit();
  });
}

let drawerCallbacks = {};

/** @param {{ onEdit?: (issue: any) => void }} callbacks 编辑按钮转交 main.js 打开表单 */
export function bindDrawer(callbacks = {}) {
  drawerCallbacks = callbacks;
}

export function openDrawer(issueId) {
  currentIssueId = issueId;
  root.hidden = false;
  document.body.classList.add('drawer-open');
  renderLoading();
  refresh();
  drawer.querySelector('.drawer-close')?.focus();
}

export function closeDrawer() {
  currentIssueId = null;
  root.hidden = true;
  document.body.classList.remove('drawer-open');
}

export function drawerIssueId() {
  return currentIssueId;
}

/** 看板数据刷新后，若抽屉开着则同步重绘（编辑/评论后保持最新） */
export async function refresh() {
  if (!currentIssueId) return;
  try {
    const { issue, comments } = await api.detail(currentIssueId);
    if (!issue) return closeDrawer();
    render(issue, comments || []);
  } catch (err) {
    if (err.status === 404) {
      toast('任务已被删除', 'error');
      return closeDrawer();
    }
    toast(`详情加载失败：${err.message}`, 'error');
  }
}

function renderLoading() {
  drawer.innerHTML = '<div class="drawer-loading">加载中…</div>';
}

function commentItemHtml(c, me) {
  const mine = me && c.authorId === me.id;
  return `
    <div class="comment">
      <div class="comment-head">
        <span class="comment-author">${esc(c.authorName || '未知')}</span>
        <span class="comment-at">${esc(fmtDateTime(c.createdAt))}</span>
        ${
          mine
            ? `<button class="icon-btn comment-del" type="button" data-drawer-act="del-comment" data-id="${c.id}" aria-label="删除评论">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
        </button>`
            : ''
        }
      </div>
      <p class="comment-body">${esc(c.body)}</p>
    </div>`;
}

function logRowHtml(log) {
  const fromLabel = log.fromStatus ? STATUS_LABELS[log.fromStatus] : '新建';
  const toLabel = STATUS_LABELS[log.toStatus] || log.toStatus;
  const actorCls = (log.actor || '').startsWith(AI_ACTOR_PREFIX) ? ' log-actor-ai' : '';
  const actorHtml = log.actor ? `<span class="log-actor${actorCls}">${esc(log.actor)}</span>` : '';
  return `
    <div class="log-item">
      <span class="log-bar"></span>
      <div>
        <div class="log-main">${esc(fromLabel)} → ${esc(toLabel)} ${actorHtml}</div>
        <div class="log-at">${esc(fmtDateTime(log.changedAt))}</div>
        ${log.reason ? `<div class="log-reason">失败原因：${esc(log.reason)}</div>` : ''}
      </div>
    </div>`;
}

function render(issue, comments) {
  const me = state.me || null;
  const typeInfo = ISSUE_TYPE_LABELS[issue.type] || ISSUE_TYPE_LABELS.task;
  const { text: dueText } = dueInfo(issue);

  const commentsHtml = comments.length
    ? comments.map((c) => commentItemHtml(c, me)).join('')
    : '<p class="drawer-empty">还没有评论</p>';

  const activityHtml = [...issue.logs].reverse().map(logRowHtml).join('');

  drawer.innerHTML = `
    <header class="drawer-head">
      <div class="drawer-title-wrap">
        <span class="drawer-no">#${issue.id}</span>
        <span class="chip type type-${esc(issue.type)}">${typeInfo.icon} ${esc(typeInfo.label)}</span>
        <h2 id="drawerTitle" class="drawer-title">${esc(issue.title)}</h2>
      </div>
      <div class="drawer-head-actions">
        <button class="btn btn-ghost" type="button" data-drawer-act="edit">编辑</button>
        <button class="icon-btn drawer-close" type="button" data-drawer-act="close" aria-label="关闭">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </div>
    </header>

    <div class="drawer-body">
      <section class="drawer-fields">
        <div class="drawer-field"><span class="fm-label">状态</span><span class="chip">${esc(STATUS_LABELS[issue.status] || issue.status)}</span></div>
        <div class="drawer-field"><span class="fm-label">优先级</span><span class="chip prio-${esc(issue.priority)}">${esc(PRIORITY_LABELS[issue.priority])}优先级</span></div>
        <div class="drawer-field"><span class="fm-label">负责人</span><span class="chip">${esc(issue.assignee || '未指派')}</span></div>
        <div class="drawer-field"><span class="fm-label">截止</span><span class="chip">${esc(dueText)}</span></div>
        ${issue.tags.length ? `<div class="drawer-field"><span class="fm-label">标签</span><span class="drawer-tags">${issue.tags.map((t) => `<span class="chip tag"># ${esc(t)}</span>`).join('')}</span></div>` : ''}
      </section>

      ${issue.description ? `<p class="drawer-desc">${esc(issue.description)}</p>` : ''}

      <section class="drawer-section">
        <h3>评论 <span class="section-count">${comments.length}</span></h3>
        <div class="comment-list">${commentsHtml}</div>
        <form id="commentForm" class="comment-form">
          <textarea name="body" rows="2" maxlength="5000" placeholder="写一条评论…（Ctrl/⌘ + Enter 发送）"></textarea>
          <button class="btn btn-primary" type="submit">发送</button>
        </form>
      </section>

      <section class="drawer-section">
        <h3>活动 <span class="section-count">${issue.logs.length}</span></h3>
        <div class="log-list open">${activityHtml || '<div class="log-from">暂无记录</div>'}</div>
      </section>
    </div>`;
}
