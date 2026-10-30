/**
 * 弹窗层：新建/编辑表单、删除二次确认、失败原因填写。
 */
import { state } from './state.js';
import { api } from './api.js';
import { STATUSES, STATUS_LABELS, FAIL_STATUS } from '/shared/constants.js';
import { esc } from './utils.js';

const $ = (sel) => document.querySelector(sel);

const modalRoot = $('#modalRoot');
const modalForm = $('#modalForm');
const modalConfirm = $('#modalConfirm');
const modalReason = $('#modalReason');
const issueForm = $('#issueForm');

/** @type {() => Promise<void>} */
let onChanged = async () => {};
/** @type {any | null} */
let pendingDelete = null;
/** @type {((v: string | null) => void) | null} */
let reasonResolver = null;

export function openModal(which) {
  modalRoot.hidden = false;
  [modalForm, modalConfirm, modalReason].forEach((m) => {
    m.hidden = m !== which;
  });
}

export function closeModals() {
  modalRoot.hidden = true;
  [modalForm, modalConfirm, modalReason].forEach((m) => {
    m.hidden = true;
  });
}

export function showFormError(msg) {
  const el = $('#formError');
  el.textContent = msg || '';
  el.hidden = !msg;
}

/** 生成状态下拉选项（此前 index.html 中为空，没有任何代码填充） */
export function populateStatusOptions() {
  const select = issueForm.status;
  select.innerHTML = STATUSES.map(
    (s) => `<option value="${esc(s)}">${esc(STATUS_LABELS[s])}</option>`
  ).join('');
}

/**
 * 打开新建/编辑表单
 * @param {any | null} issue 传 null 表示新建
 * @param {string | null} presetStatus 新建时的默认状态
 */
export function openForm(issue = null, presetStatus = null) {
  state.editingId = issue?.id ?? null;
  $('#formTitle').textContent = issue ? '编辑任务' : '新建任务';
  showFormError('');

  const f = issueForm;
  f.title.value = issue?.title ?? '';
  f.description.value = issue?.description ?? '';
  f.priority.value = issue?.priority ?? 'medium';
  f.assignee.value = issue?.assignee ?? '';
  f.status.value = issue?.status ?? presetStatus ?? 'backlog';
  f.dueDate.value = issue?.dueDate ?? '';
  f.tags.value = (issue?.tags ?? []).join(', ');
  f.failReason.value = '';

  syncReasonVisibility();
  openModal(modalForm);
  setTimeout(() => f.title.focus(), 60);
}

/**
 * 仅当「新建」或「状态变更为失败」时才要求填写失败原因；
 * 编辑一个本就在失败列的任务、只改其他字段时不应被拦。
 * @returns {boolean}
 */
export function syncReasonVisibility() {
  const editing = state.editingId
    ? state.issues.find((i) => i.id === state.editingId)
    : null;
  const isFailed = issueForm.status.value === FAIL_STATUS;
  const needReason = isFailed && (!editing || editing.status !== FAIL_STATUS);

  $('#reasonRow').hidden = !needReason;
  issueForm.failReason.required = needReason;
  return needReason;
}

async function submitForm(e) {
  e.preventDefault();
  const f = e.target;

  const title = f.title.value.trim();
  if (!title) {
    showFormError('请填写任务标题');
    f.title.focus();
    return;
  }

  const needReason = syncReasonVisibility();
  const reason = f.failReason.value.trim();
  if (needReason && !reason) {
    showFormError('状态为「失败」时必须填写失败原因，否则无法保存');
    f.failReason.focus();
    return;
  }

  const payload = {
    title,
    description: f.description.value.trim(),
    priority: f.priority.value,
    assignee: f.assignee.value.trim(),
    tags: f.tags.value,
    dueDate: f.dueDate.value || null,
    status: f.status.value,
    failReason: reason,
  };

  try {
    if (state.editingId) {
      await api.update(state.editingId, payload);
      closeModals();
      await onChanged();
      toast('任务已更新', 'success');
    } else {
      await api.create(payload);
      closeModals();
      await onChanged();
      toast('任务已创建', 'success');
    }
  } catch (err) {
    showFormError(err.message);
  }
}

/** 删除二次确认 */
export function askDelete(issue) {
  pendingDelete = issue;
  $('#confirmText').innerHTML =
    `确定要删除任务「<strong>${esc(issue.title)}</strong>」吗？<br>该操作不可撤销，` +
    `任务的标签与状态变更记录将一并删除。`;
  openModal(modalConfirm);
  setTimeout(() => $('#confirmOk').focus(), 60);
}

/**
 * 拖入「失败」列时填写原因
 * @param {any} issue
 * @returns {Promise<string | null>} 用户取消或关闭时返回 null
 */
export function askFailureReason(issue) {
  $('#reasonIssueName').textContent = issue.title;
  $('#reasonInput').value = '';
  $('#reasonError').hidden = true;
  openModal(modalReason);
  setTimeout(() => $('#reasonInput').focus(), 60);

  return new Promise((resolve) => {
    reasonResolver = resolve;
  });
}

function resolveReason(value) {
  const done = reasonResolver;
  reasonResolver = null;
  if (done) done(value);
}

/** 是否存在等待用户填写的失败原因弹窗 */
export function hasPendingReason() {
  return reasonResolver !== null;
}

/**
 * 取消待填写的失败原因：放弃本次移动并关闭弹窗。
 * 抽出来是为了让 Esc 键与背景点击走同一条路径，
 * 否则直接关闭会让 await askFailureReason(...) 的 Promise 永远悬挂。
 * @returns {boolean} 是否确实取消了一个待处理的弹窗
 */
export function cancelPendingReason() {
  if (!reasonResolver) return false;
  resolveReason(null);
  toast('已取消移动：未填写失败原因，任务保留在原列', 'error');
  closeModals();
  return true;
}

export function initModals(callbacks = {}) {
  if (callbacks.onChanged) onChanged = callbacks.onChanged;

  populateStatusOptions();

  issueForm.addEventListener('submit', submitForm);

  issueForm.status.addEventListener('change', () => {
    syncReasonVisibility();
    showFormError('');
  });

  // 背景与 [data-close] 元素均可关闭
  modalRoot.addEventListener('click', (e) => {
    if (!e.target.dataset.close) return;
    if (!cancelPendingReason()) closeModals();
  });

  $('#confirmOk').addEventListener('click', async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    pendingDelete = null;
    closeModals();
    try {
      await api.remove(target.id);
      toast('任务已删除', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      await onChanged();
    }
  });

  const confirmReason = () => {
    const value = $('#reasonInput').value.trim();
    if (!value) {
      const err = $('#reasonError');
      err.textContent = '请填写失败原因，未填写将无法移动到「失败」列';
      err.hidden = false;
      $('#reasonInput').focus();
      return;
    }
    resolveReason(value);
    closeModals();
  };

  $('#reasonOk').addEventListener('click', confirmReason);
  $('#reasonInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) confirmReason();
  });
}
