/**
 * 多看板 workspace：顶栏看板切换器 + 新建看板弹窗。
 *
 * 数据流与筛选下拉一致：事件 → state → notify() → 视图重绘。
 * 切换看板 = 换一份 issue 集合，因此要连带清空筛选/勾选/展开态并重新拉取；
 * 当前看板 id 写 localStorage（issue-board:boardId），其他标签页经由
 * sync.js 的 storage 监听跟随切换，保持多标签一致。
 *
 * 删除看板的二次确认复用 modals.js 的确认弹窗（它统一持有 pendingDelete），
 * 这里只负责入口按钮；确认后的落库与收尾由 modals.js → main.js 完成。
 */
import { state, resetFilters, clearSelection, pruneSelection } from './state.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { esc } from './utils.js';

const $ = (sel) => document.querySelector(sel);

const STORAGE_KEY = 'issue-board:boardId';

/** @type {(() => Promise<void>) | null} 切换看板后由 main.js 注入的看板重载 */
let onBoardChanged = null;
/** @type {((board: any) => void) | null} 删除入口：转交 modals.js 的二次确认 */
let askDeleteBoardFn = null;
/** @type {() => void} 关闭详情抽屉（切换看板时旧卡可能不属于新看板） */
let closeDrawerFn = () => {};
/** @type {() => void} 重置列表视图分页 */
let resetListPageFn = () => {};

/** @returns {number | null} localStorage 里记住的看板 id */
function savedBoardId() {
  try {
    const v = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function saveBoardId(id) {
  try {
    if (id == null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(id));
  } catch {
    /* 隐私模式下降级：不记住选择，仅本次会话生效 */
  }
}

/**
 * 拉取看板列表并校正当前选择：记住的看板已不存在（被别处删除）时
 * 回退到第一个看板。返回是否拿到了至少一个看板。
 */
export async function loadBoards() {
  try {
    const data = await api.boards();
    state.boards = data.boards ?? [];
  } catch {
    /* 看板列表失败不致命：沿用现有选择，顶栏隐藏 */
    $('#boardSwitch').hidden = true;
    return false;
  }

  const ids = state.boards.map((b) => b.id);
  if (!ids.length) {
    state.currentBoardId = null;
    $('#boardSwitch').hidden = true;
    return false;
  }
  if (!ids.includes(state.currentBoardId)) {
    const saved = savedBoardId();
    state.currentBoardId = ids.includes(saved) ? saved : ids[0];
    saveBoardId(state.currentBoardId);
  }
  $('#boardSwitch').hidden = false;
  renderBoardSwitch();
  syncWriteUI();
  return true;
}

/** 顶栏切换器：触发器文案 + 面板选项（单选 + 新建入口 + 受控删除） */
export function renderBoardSwitch() {
  const sw = $('#boardSwitch');
  if (sw.hidden) return;

  const current = state.boards.find((b) => b.id === state.currentBoardId);
  $('#boardLabel').textContent = current ? current.name : '看板';

  // 删除入口按板判定：owner 且（多块板时）才显示；viewer 对他人板无删除权（服务端同拦）
  const deletable = (b) => b.myRole === 'owner' && state.boards.length > 1;
  const options = state.boards
    .map((b) => {
      const checked = b.id === state.currentBoardId;
      return `
        <button class="drop-opt${checked ? ' selected' : ''}" type="button" role="option"
                aria-selected="${checked}" data-board-id="${b.id}" title="${esc(b.description || b.name)}">
          <span class="drop-check">
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>
          </span>
          <span class="board-opt-name">${esc(b.name)}</span>
          <span class="board-opt-count">${b.issueCount}</span>
          ${
            deletable(b)
              ? `<span class="icon-btn board-del" data-board-del="${b.id}" role="button" aria-label="删除看板「${esc(b.name)}」" title="删除该看板及其全部任务">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
                </span>`
              : ''
          }
        </button>`;
    })
    .join('');

  $('#panelBoard').innerHTML =
    options +
    `<button class="drop-opt board-create" type="button" data-board-create="1">
      <span class="board-create-plus">＋</span><span>新建看板</span>
    </button>` +
    (isOwner()
      ? `<button class="drop-opt board-members" type="button" data-board-members="1">
          <span class="board-create-plus">👥</span><span>成员管理</span>
        </button>`
      : '');
}

/**
 * 切换看板：清空筛选/勾选/展开态，关掉抽屉，重新拉取。
 * @param {number} id
 */
export async function switchBoard(id) {
  if (id === state.currentBoardId) return;
  state.currentBoardId = id;
  saveBoardId(id);
  resetFilters();
  clearSelection();
  state.expanded.clear();
  resetListPageFn();
  closeDrawerFn();
  renderBoardSwitch();
  syncWriteUI();
  if (onBoardChanged) await onBoardChanged();
}

/**
 * 当前看板数据变化（issue 增删/移入移出）后由 main.js 调用：
 * 重算勾选残留并刷新切换器上的计数。
 */
export function syncBoardAfterDataChange() {
  pruneSelection(new Set(state.issues.map((i) => i.id)));
  const current = state.boards.find((b) => b.id === state.currentBoardId);
  if (current) current.issueCount = state.issues.length;
  renderBoardSwitch();
}

/** 是否已选定看板；没有时主流程不应继续拉 issue */
export function hasBoard() {
  return state.currentBoardId != null;
}

/**
 * 当前用户在当前看板的角色（'owner' | 'member' | 'viewer'）。
 * 板列表还没回来时按 'member' 兜底：写操作交给服务端护栏拦截，
 * 前端只做入口收敛，绝不放大权限。
 * @returns {'owner' | 'member' | 'viewer'}
 */
export function myRole() {
  const board = state.boards.find((b) => b.id === state.currentBoardId);
  return board?.myRole ?? 'member';
}

/** 是否可写（owner / member）：viewer 收起新建、导出、成员管理等入口 */
export function canWrite() {
  return myRole() !== 'viewer';
}

/** 是否为看板 owner（成员管理入口） */
export function isOwner() {
  return myRole() === 'owner';
}

/** 依据角色收敛写操作入口（新建/导出按钮的显隐），看板切换与数据刷新后调用 */
export function syncWriteUI() {
  const write = canWrite();
  $('#btnNew').hidden = !write;
  $('#btnExport').hidden = !write || !hasBoard();
}

/** 关闭看板下拉（Esc / 点击空白处；由 main.js 统一调度） */
export function closeBoardPanel() {
  const sw = $('#boardSwitch');
  if (!sw || sw.hidden) return;
  sw.querySelector('.drop-trigger')?.setAttribute('aria-expanded', 'false');
  $('#panelBoard').classList.remove('open');
}

/** 打开新建看板弹窗（模态遮罩归 modals.js 管，这里只翻各弹窗的 hidden） */
export function openBoardModal() {
  const form = $('#boardForm');
  form.reset();
  $('#boardFormError').hidden = true;
  $('#modalRoot').hidden = false;
  [$('#modalForm'), $('#modalConfirm'), $('#modalReason')].forEach((m) => {
    m.hidden = true;
  });
  $('#modalBoard').hidden = false;
  setTimeout(() => form.elements.namedItem('name').focus(), 60);
}

const ROLE_LABELS = { owner: '所有者', member: '成员', viewer: '只读' };

/**
 * 成员管理弹窗：owner 可增删改角色；非 owner 只读浏览（服务端护栏兜底）。
 * 成员列表与可选用户每次打开都拉最新。
 */
export async function openMembersModal() {
  const boardId = state.currentBoardId;
  if (!boardId) return;
  $('#modalRoot').hidden = false;
  [$('#modalForm'), $('#modalConfirm'), $('#modalReason'), $('#modalBoard')].forEach((m) => {
    m.hidden = true;
  });
  $('#modalMembers').hidden = false;
  $('#membersError').hidden = true;

  const owner = isOwner();
  $('#membersTitle').textContent = `看板成员 · ${state.boards.find((b) => b.id === boardId)?.name ?? ''}`;

  let members = [];
  try {
    members = (await api.members(boardId)).members ?? [];
  } catch (err) {
    $('#membersError').textContent = err.message;
    $('#membersError').hidden = false;
    return;
  }

  const roleSelect = (userId, role) => `
    <select class="member-role" data-user-id="${userId}" ${owner ? '' : 'disabled'}>
      ${['owner', 'member', 'viewer']
        .map((r) => `<option value="${r}"${r === role ? ' selected' : ''}>${ROLE_LABELS[r]}</option>`)
        .join('')}
    </select>`;

  $('#membersList').innerHTML = members
    .map(
      (m) => `
      <div class="member-row" data-user-id="${m.userId}">
        <span class="member-name">${esc(m.displayName || m.username)}<em>@${esc(m.username)}</em></span>
        ${roleSelect(m.userId, m.role)}
        ${
          owner
            ? `<span class="icon-btn member-del" data-remove-id="${m.userId}" role="button" aria-label="移除成员" title="移除该成员">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
              </span>`
            : ''
        }
      </div>`,
    )
    .join('');

  // 添加成员：只列还不是成员的用户
  const memberIds = new Set(members.map((m) => m.userId));
  const candidates = state.users.filter((u) => !memberIds.has(u.id));
  $('#memberAddRow').hidden = !owner;
  $('#memberUser').innerHTML = candidates.length
    ? candidates
        .map(
          (u) => `<option value="${u.id}">${esc(u.displayName || u.username)} @${esc(u.username)}</option>`,
        )
        .join('')
    : '<option value="">所有用户都已在看板中</option>';
  $('#memberRole').value = 'member';
  $('#memberAddBtn').disabled = !candidates.length;
}

/** 成员弹窗内的增删改（事件委托绑定一次） */
function bindMembersModal() {
  const modal = $('#modalMembers');

  const reload = () => openMembersModal();

  // 改角色
  modal.addEventListener('change', async (e) => {
    const select = e.target.closest('.member-role');
    if (!select) return;
    try {
      await api.addMember({
        boardId: state.currentBoardId,
        userId: Number(select.dataset.userId),
        role: select.value,
      });
      toast('角色已更新', 'success');
      await reload();
    } catch (err) {
      toast(err.message, 'error');
      await reload();
    }
  });

  // 移除成员
  modal.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-remove-id]');
    if (!del) return;
    try {
      await api.removeMember(state.currentBoardId, Number(del.dataset.removeId));
      toast('成员已移除', 'success');
      await reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // 添加成员
  $('#memberAddBtn').addEventListener('click', async () => {
    const userId = Number($('#memberUser').value);
    if (!userId) return;
    try {
      await api.addMember({ boardId: state.currentBoardId, userId, role: $('#memberRole').value });
      toast('成员已添加', 'success');
      await reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/**
 * @param {{ onBoardChanged?: () => Promise<void>, askDeleteBoard?: (board: any) => void, closeDrawer?: () => void, resetListPage?: () => void }} callbacks
 */
export function initBoards(callbacks = {}) {
  if (callbacks.onBoardChanged) onBoardChanged = callbacks.onBoardChanged;
  if (callbacks.askDeleteBoard) askDeleteBoardFn = callbacks.askDeleteBoard;
  if (callbacks.closeDrawer) closeDrawerFn = callbacks.closeDrawer;
  if (callbacks.resetListPage) resetListPageFn = callbacks.resetListPage;
  bindMembersModal();

  const sw = $('#boardSwitch');
  const trigger = sw.querySelector('.drop-trigger');
  const panel = $('#panelBoard');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !panel.classList.contains('open');
    document.querySelectorAll('.dropdown').forEach((d) => {
      d.querySelector('.drop-trigger')?.setAttribute('aria-expanded', 'false');
      d.querySelector('.drop-panel')?.classList.remove('open');
    });
    if (willOpen) {
      renderBoardSwitch();
      panel.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
    }
  });

  panel.addEventListener('click', async (e) => {
    e.stopPropagation();

    // 新建看板：走独立弹窗（不与 issue 表单耦合）
    if (e.target.closest('[data-board-create]')) {
      panel.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      openBoardModal();
      return;
    }

    // 成员管理：owner 专属入口
    if (e.target.closest('[data-board-members]')) {
      panel.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      await openMembersModal();
      return;
    }

    // 删除看板：转交 modals.js 的二次确认，确认后的落库不在本模块
    const del = e.target.closest('[data-board-del]');
    if (del) {
      panel.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      const board = state.boards.find((b) => b.id === Number(del.dataset.boardDel));
      if (board) askDeleteBoardFn?.(board);
      return;
    }

    // 切换看板
    const opt = e.target.closest('[data-board-id]');
    if (!opt) return;
    panel.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    await switchBoard(Number(opt.dataset.boardId));
  });

  // 新建看板表单：成功后重载看板列表并切换过去
  const boardForm = $('#boardForm');
  boardForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#boardFormError');
    errEl.hidden = true;
    const name = boardForm.elements.namedItem('name').value.trim();
    if (!name) {
      errEl.textContent = '请填写看板名';
      errEl.hidden = false;
      return;
    }
    try {
      const data = await api.createBoard({
        name,
        description: boardForm.elements.namedItem('description').value.trim(),
      });
      $('#modalBoard').hidden = true;
      $('#modalRoot').hidden = true;
      toast('看板已创建', 'success');
      const okLoad = await loadBoards();
      if (okLoad && data.board?.id) await switchBoard(data.board.id);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });
}
