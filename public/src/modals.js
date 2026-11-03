/**
 * 弹窗层：新建/编辑表单、删除二次确认、失败原因填写。
 *
 * 取表单控件统一走 form.elements.namedItem(name)，
 * 而不是 form[name] —— 后者依赖 HTMLFormElement 的命名属性访问，
 * 在不同运行时（jsdom / 各浏览器）下行为并不完全一致。
 */
import { state } from './state.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { STATUSES, STATUS_LABELS, FAIL_STATUS, MSG_MOVE_CANCELLED_NO_REASON } from '../../shared/constants.js';
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

/** 取表单字段元素 @param {string} name */
const field = (name) => issueForm.elements.namedItem(name);

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

/** 填充状态下拉选项；此前 index.html 中该 select 为空且无人填充 */
export function populateStatusOptions() {
  const select = field('status');
  if (!select) return;
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

  field('title').value = issue?.title ?? '';
  field('description').value = issue?.description ?? '';
  field('priority').value = issue?.priority ?? 'medium';
  field('assignee').value = issue?.assignee ?? '';
  field('status').value = issue?.status ?? presetStatus ?? 'backlog';
  field('dueDate').value = issue?.dueDate ?? '';
  field('tags').value = (issue?.tags ?? []).join(', ');
  field('failReason').value = '';

  syncReasonVisibility();
  openModal(modalForm);
  setTimeout(() => field('title').focus(), 60);
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
  const statusEl = field('status');
  const reasonEl = field('failReason');
  if (!statusEl || !reasonEl) return false;

  const isFailed = statusEl.value === FAIL_STATUS;
  const needReason = isFailed && (!editing || editing.status !== FAIL_STATUS);

  $('#reasonRow').hidden = !needReason;
  reasonEl.required = needReason;
  return needReason;
}

async function submitForm(e) {
  e.preventDefault();

  const title = field('title').value.trim();
  if (!title) {
    showFormError('请填写任务标题');
    field('title').focus();
    return;
  }

  const needReason = syncReasonVisibility();
  const reason = field('failReason').value.trim();
  if (needReason && !reason) {
    showFormError('状态为「失败」时必须填写失败原因，否则无法保存');
    field('failReason').focus();
    return;
  }

  const editing = state.editingId
    ? state.issues.find((i) => i.id === state.editingId)
    : null;

  const payload = {
    title,
    description: field('description').value.trim(),
    priority: field('priority').value,
    assignee: field('assignee').value.trim(),
    tags: field('tags').value,
    dueDate: field('dueDate').value || null,
    status: field('status').value,
    failReason: reason,
  };

  // 乐观锁：把「打开表单时看到的版本号」带回服务端，被别人改过就拒绝提交
  if (editing && editing.version != null) payload.expectedVersion = editing.version;

  try {
    if (state.editingId) {
      await api.update(state.editingId, payload);
      toast('任务已更新', 'success');
    } else {
      await api.create(payload);
      toast('任务已创建', 'success');
    }
    closeModals();
    await onChanged();
  } catch (err) {
    // 冲突时先把最新数据拉回来，用户重试即可覆盖，不用手动刷新页面
    if (err.status === 409) await onChanged();
    showFormError(err.message);
  }
}

/** 删除二次确认 */
export function askDelete(issue) {
  pendingDelete = { id: issue.id, title: issue.title };
  $('#confirmText').innerHTML =
    `确定要删除任务「<strong>${esc(issue.title)}</strong>」吗？<br>该操作不可撤销，` +
    `任务的标签与状态变更记录将一并删除。`;
  openModal(modalConfirm);
  setTimeout(() => $('#confirmOk').focus(), 60);
}

/**
 * 批量删除二次确认：与单条删除共用同一个确认弹窗，
 * 只是落库时走批量接口。
 * @param {number[]} ids
 */
export function askDeleteMany(ids) {
  if (!ids.length) return;
  pendingDelete = { ids: [...ids] };
  $('#confirmText').innerHTML =
    `确定要删除选中的 <strong>${ids.length}</strong> 个任务吗？<br>该操作不可撤销，` +
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
  toast(MSG_MOVE_CANCELLED_NO_REASON, 'error');
  closeModals();
  return true;
}

export function initModals(callbacks = {}) {
  if (callbacks.onChanged) onChanged = callbacks.onChanged;

  populateStatusOptions();

  issueForm.addEventListener('submit', submitForm);

  field('status').addEventListener('change', () => {
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
      // 批量删除与单条删除共用确认弹窗，靠 ids 是否数组区分
      if (Array.isArray(target.ids)) {
        const res = await api.batchRemove(target.ids);
        const skipped = res?.failed?.length ?? 0;
        toast(
          skipped
            ? `已删除 ${res.deleted} 个任务，${skipped} 个失败`
            : `已删除 ${res?.deleted ?? target.ids.length} 个任务`,
          skipped ? 'error' : 'success'
        );
      } else {
        await api.remove(target.id);
        toast('任务已删除', 'success');
      }
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
