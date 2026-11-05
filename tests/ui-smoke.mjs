/**
 * 前端 UI 冒烟测试（jsdom）
 * -------------------------------------------------------------
 * 覆盖 API 测试够不到的那一层：骨架渲染、卡片复用、状态下拉填充、
 * 筛选与列计数、以及「拖入失败列必须填原因」的交互闸门。
 *
 * 运行：node tests/ui-smoke.mjs   （不需要数据库、不需要起服务）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra ? ` -> ${extra}` : ''}`);
  }
}

// ---------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const ymd = (d) => new Date(NOW + d * 86400000).toISOString().slice(0, 10);

function mkIssue(id, over = {}) {
  return {
    id,
    title: `任务${id}`,
    type: 'task',
    description: `描述${id}`,
    priority: 'medium',
    assignee: '周野',
    assigneeId: null,
    commentCount: 0,
    tags: [],
    dueDate: ymd(5),
    status: 'backlog',
    boardId: 1,
    boardName: '默认看板',
    position: id,
    version: 1,
    createdAt: iso(id * 1000),
    updatedAt: iso(id * 1000),
    logs: [{ id: id * 10, fromStatus: '', toStatus: 'backlog', reason: '', changedAt: iso(id * 1000) }],
    ...over,
  };
}

const FIXTURE = [
  mkIssue(1, { priority: 'high', assignee: '周野', tags: ['后端', 'MCP'], status: 'in_progress' }),
  mkIssue(2, { priority: 'low', assignee: '林悦', tags: ['设计'], status: 'done' }),
  mkIssue(3, { priority: 'medium', assignee: '苏可', tags: ['前端'], status: 'planning' }),
  mkIssue(4, {
    priority: 'high',
    assignee: '周野',
    tags: ['后端'],
    status: 'failed',
    logs: [
      { id: 40, fromStatus: '', toStatus: 'backlog', reason: '', changedAt: iso(4000) },
      { id: 41, fromStatus: 'backlog', toStatus: 'failed', reason: '接口不可用', changedAt: iso(3000) },
    ],
  }),
  mkIssue(5, { priority: 'low', assignee: '陈默', tags: ['工具'], status: 'backlog' }),
];

/** 看板 fixture：可变的，供新建/删除看板用例模拟服务端状态 */
const USERS_FIXTURE = [
  { id: 1, username: 'tester', displayName: '测试用户' },
  { id: 2, username: 'zhouye', displayName: '周野' },
];
const MEMBERS = { 1: [{ userId: 1, username: 'tester', displayName: '测试用户', role: 'owner' }] };

const BOARDS = [
  {
    id: 1,
    name: '默认看板',
    description: '开箱即用的第一个看板',
    myRole: 'owner',
    issueCount: 5,
    createdAt: iso(90000),
  },
  {
    id: 2,
    name: '产品规划',
    description: '长期路线图',
    myRole: 'viewer',
    issueCount: 0,
    createdAt: iso(80000),
  },
];

// ---------------------------------------------------------------
// 启动 jsdom
// ---------------------------------------------------------------
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.CustomEvent = window.CustomEvent;
globalThis.DataTransfer = window.DataTransfer;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/api/health')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, connected: true, db: 'issue_board' }) };
  }
  if (u.includes('/api/auth/me')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ user: { id: 1, username: 'tester', displayName: '测试用户' } }),
    };
  }
  if (u.includes('/api/users')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ users: USERS_FIXTURE }),
    };
  }
  // 成员管理：GET 列表 / POST 添加 / DELETE 移除（内存态，与 BOARDS 一样可变）
  if (/\/api\/boards\/\d+\/members/.test(u)) {
    const bid = Number(u.match(/\/api\/boards\/(\d+)\/members/)[1]);
    if (!MEMBERS[bid])
      MEMBERS[bid] = [{ userId: 1, username: 'tester', displayName: '测试用户', role: 'owner' }];
    if (opts?.method === 'POST') {
      const body = JSON.parse(opts.body);
      const user = USERS_FIXTURE.find((x) => x.id === body.userId);
      const existing = MEMBERS[bid].find((m) => m.userId === body.userId);
      if (existing) existing.role = body.role;
      else
        MEMBERS[bid].push({
          userId: body.userId,
          username: user?.username || `u${body.userId}`,
          displayName: user?.displayName || '',
          role: body.role,
        });
      return {
        ok: true,
        status: 201,
        json: async () => ({ updated: true, boardId: bid, userId: body.userId, role: body.role }),
      };
    }
    if (opts?.method === 'DELETE') {
      const uid = Number(u.match(/members\/(\d+)/)[1]);
      MEMBERS[bid] = MEMBERS[bid].filter((m) => m.userId !== uid);
      return { ok: true, status: 200, json: async () => ({ removed: true, boardId: bid, userId: uid }) };
    }
    return { ok: true, status: 200, json: async () => ({ members: MEMBERS[bid] }) };
  }

  if (u.includes('/api/boards') && !u.includes('/api/issues')) {
    // 看板删除走 /api/boards/:id，先按服务端语义处理再返回
    if (opts?.method === 'DELETE') {
      const id = Number(u.match(/\/api\/boards\/(\d+)/)?.[1]);
      const idx = BOARDS.findIndex((b) => b.id === id);
      const removed = BOARDS.splice(idx, 1)[0];
      return { ok: true, status: 200, json: async () => ({ deleted: true, id, name: removed.name }) };
    }
    if (opts?.method === 'POST') {
      const body = JSON.parse(opts.body);
      const board = {
        id: Math.max(...BOARDS.map((b) => b.id)) + 1,
        name: body.name,
        description: body.description || '',
        myRole: 'owner',
        issueCount: 0,
        createdAt: new Date().toISOString(),
      };
      BOARDS.push(board);
      return { ok: true, status: 201, json: async () => ({ created: true, board }) };
    }
    return { ok: true, status: 200, json: async () => ({ boards: BOARDS }) };
  }
  // issue 详情（抽屉用）：从 FIXTURE 取，附两条评论
  const detailMatch = u.match(/\/api\/issues\/(\d+)$/);
  if (detailMatch) {
    const issue = FIXTURE.find((i) => i.id === Number(detailMatch[1]));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        issue,
        comments: [
          { id: 1, authorId: 2, authorName: '周野', body: '来自 mock 的评论', createdAt: iso(1000) },
        ],
      }),
    };
  }
  // 导出 CSV：服务端返回 Blob + 响应头（与真实实现同构）
  if (u.includes('/api/export/csv')) {
    const disposition =
      `attachment; filename="cloudissue-export.csv"; filename*=UTF-8''` +
      encodeURIComponent('cloudissue-默认看板-2026-11-05.csv');
    return {
      ok: true,
      status: 200,
      headers: new Headers({
        'Content-Disposition': disposition,
        'X-Export-Count': String(FIXTURE.filter((i) => i.boardId === 1).length),
      }),
      blob: async () => new Blob(['\uFEFF#编号,标题'], { type: 'text/csv' }),
    };
  }
  if (u.includes('/api/issues')) {
    // 多看板：?boardId= 只返回该看板的任务（与服务端语义一致）
    const bid = Number(u.match(/boardId=(\d+)/)?.[1]);
    const rows = bid ? FIXTURE.filter((i) => i.boardId === bid) : FIXTURE;
    return { ok: true, status: 200, json: async () => ({ issues: rows }) };
  }
  throw new Error('unexpected url ' + url);
};
window.fetch = globalThis.fetch;

const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));

let modals;
let state;

try {
  // render.js 仅为了解其模块副作用（订阅 onChange），测试不直接引用
  await import('../public/src/render.js');
  state = await import('../public/src/state.js');
  modals = await import('../public/src/modals.js');
  await import('../public/src/main.js');
  await wait(120);
} catch (err) {
  console.error('模块加载失败:', err);
  process.exit(1);
}

const { state: s, notify } = state;
const $ = (sel) => document.querySelector(sel);
const countText = (status) => $(`.column[data-status="${status}"] .col-count`).textContent;
const cardCount = () => document.querySelectorAll('.card').length;

// ---------------------------------------------------------------
// 用例
// ---------------------------------------------------------------
console.log('\n--- 1. 看板骨架 ---');
const columns = [...document.querySelectorAll('.column')];
check('渲染出 5 列', columns.length === 5, String(columns.length));
check(
  '列顺序为 未规划/规划中/进行中/已完成/失败',
  JSON.stringify(columns.map((c) => c.dataset.status)) ===
    JSON.stringify(['backlog', 'planning', 'in_progress', 'done', 'failed']),
  columns.map((c) => c.dataset.status).join(','),
);
check('失败列带 is-fail 标记', Boolean($('.column.is-fail')));

console.log('\n--- 2. 卡片渲染 ---');
check('渲染出 5 张卡片', cardCount() === 5, String(cardCount()));
check(
  '卡片可拖拽',
  [...document.querySelectorAll('.card')].every((c) => c.getAttribute('draggable') === 'true'),
);
check(
  '卡片带优先级标识',
  [...document.querySelectorAll('.card')].every((c) => Boolean(c.dataset.priority)),
);

console.log('\n--- 3. 状态下拉（此前为空的缺陷） ---');
const statusSelect = $('#issueForm [name="status"]');
check('状态下拉元素存在', Boolean(statusSelect));
const opts = statusSelect ? [...statusSelect.options] : [];
check('状态下拉有 5 个选项', opts.length === 5, String(opts.length));
check(
  '状态选项取值覆盖五列',
  JSON.stringify(opts.map((o) => o.value)) ===
    JSON.stringify(['backlog', 'planning', 'in_progress', 'done', 'failed']),
  opts.map((o) => o.value).join(','),
);
check(
  '状态选项文案为中文列名',
  JSON.stringify(opts.map((o) => o.textContent.trim())) ===
    JSON.stringify(['未规划', '规划中', '进行中', '已完成', '失败']),
  opts.map((o) => o.textContent.trim()).join(','),
);

console.log('\n--- 4. 列计数（筛选后/总数） ---');
check('未规划列显示 1/1', countText('backlog') === '1/1', countText('backlog'));
check('进行中列显示 1/1', countText('in_progress') === '1/1', countText('in_progress'));

console.log('\n--- 5. 关键词筛选 ---');
s.filters.keyword = '任务2';
notify();
check('筛选后仅剩 1 张卡片', cardCount() === 1, String(cardCount()));
check('已完成列显示 1/1', countText('done') === '1/1', countText('done'));
check('未规划列显示 0/1', countText('backlog') === '0/1', countText('backlog'));

s.filters.keyword = '不存在的关键词';
notify();
check('无匹配时不渲染卡片', cardCount() === 0, String(cardCount()));
check('显示「无匹配任务」空状态', document.body.textContent.includes('无匹配任务'));

console.log('\n--- 6. 组合筛选（关键词 AND 负责人） ---');
s.filters.keyword = '任务';
s.filters.assignee = new Set(['周野']);
notify();
check('组合筛选后剩 2 张卡片', cardCount() === 2, String(cardCount()));

console.log('\n--- 7. 清空筛选 ---');
s.filters.keyword = '';
s.filters.assignee.clear();
notify();
check('清空后恢复 5 张卡片', cardCount() === 5, String(cardCount()));

console.log('\n--- 8. 失败原因闸门（取消则不移动） ---');
const target = FIXTURE[0];
const beforeStatus = target.status;

const apiMod = await import('../public/src/api.js');
let movedCalled = false;
const origMove = apiMod.api.move;
apiMod.api.move = async () => {
  movedCalled = true;
  return { moved: true };
};

const reasonPromise = modals.askFailureReason(target);
modals.cancelPendingReason();
const reason = await reasonPromise;

check('取消后返回 null', reason === null, String(reason));
await wait(20);
check('取消后不调用移动接口', movedCalled === false);
check('卡片状态未变化', target.status === beforeStatus, target.status);

apiMod.api.move = origMove;

console.log('\n--- 9. 状态下拉联动失败原因输入框 ---');
const form = $('#issueForm');
form.elements.namedItem('status').value = 'failed';
const needReason = modals.syncReasonVisibility();
check('选为失败时要求填写原因', needReason === true);
check('失败原因行可见', $('#reasonRow').hidden === false);

form.elements.namedItem('status').value = 'done';
const needReason2 = modals.syncReasonVisibility();
check('选为非失败时不要求原因', needReason2 === false);
check('失败原因行隐藏', $('#reasonRow').hidden === true);

console.log('\n--- 10. 乐观更新与回滚 ---');
const dnd = await import('../public/src/dnd.js');
const inCol = (status, id) =>
  Boolean(document.querySelector(`.column[data-status="${status}"] .card[data-id="${id}"]`));

check('移动前卡片在进行中列', inCol('in_progress', 1));
const snap = dnd.applyMoveOptimistic(1, 'done', null);
check('乐观更新返回了回滚快照', Array.isArray(snap) && snap.length === 5, String(snap && snap.length));
check('无需往返即可看到卡片落在目标列', inCol('done', 1));
check('原列不再有该卡片', inCol('in_progress', 1) === false);
check('卡片总数未变（无重复节点）', cardCount() === 5, String(cardCount()));

s.issues = snap;
notify();
check('回滚后卡片回到原列', inCol('in_progress', 1));
check('回滚后目标列不再有该卡片', inCol('done', 1) === false);
check('回滚后卡片总数仍为 5', cardCount() === 5, String(cardCount()));

console.log('\n--- 11. 跨标签页同步 ---');
const sync = await import('../public/src/sync.js');

// 统计看板拉取次数，用来判断是否真的重新拉了数据
let listCalls = 0;
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/api/issues')) listCalls += 1;
  return origFetch(url, opts);
};
window.fetch = globalThis.fetch;

window.localStorage.removeItem('issue-board:rev');
sync.bumpRevision();
check('写库成功后写出修订号', window.localStorage.getItem('issue-board:rev') !== null);

const callsBeforeEvent = listCalls;
const storageEvent = new window.Event('storage');
storageEvent.key = 'issue-board:rev';
window.dispatchEvent(storageEvent);
await wait(200);
check(
  '收到其他标签页的变更通知后自动刷新',
  listCalls > callsBeforeEvent,
  `${callsBeforeEvent} -> ${listCalls}`,
);

const callsBeforeUnrelated = listCalls;
const otherEvent = new window.Event('storage');
otherEvent.key = 'some-unrelated-key';
window.dispatchEvent(otherEvent);
await wait(200);
check('无关 key 不触发刷新', listCalls === callsBeforeUnrelated, `${callsBeforeUnrelated} -> ${listCalls}`);

const callsBeforeVisible = listCalls;
document.dispatchEvent(new window.Event('visibilitychange'));
await wait(200);
check('切回前台时兜底刷新一次', listCalls > callsBeforeVisible, `${callsBeforeVisible} -> ${listCalls}`);

console.log('\n--- 12. 乐观并发控制（前端） ---');
{
  const base = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/move')) {
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: '任务已被其他人修改（当前版本 v3，你的版本 v2），请刷新后重试',
          conflict: true,
          currentVersion: 3,
        }),
      };
    }
    return base(url, opts);
  };
  window.fetch = globalThis.fetch;

  let errStatus = null;
  let errMsg = '';
  try {
    await apiMod.api.move(1, { toStatus: 'done' });
  } catch (err) {
    errStatus = err.status;
    errMsg = err.message;
  }
  check('冲突响应抛出 409', errStatus === 409, String(errStatus));
  check('冲突提示可直接展示给用户', /已被其他人修改/.test(errMsg || ''), errMsg);

  globalThis.fetch = base;
  window.fetch = base;
}

console.log('\n--- 13. 触屏拖拽（Pointer Events） ---');
{
  const card1 = document.querySelector('.column[data-status="in_progress"] .card[data-id="1"]');
  const ptr = (type, target, opts = {}) => {
    const ev = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(ev, { pointerType: 'touch', pointerId: 7, clientX: 0, clientY: 0, ...opts });
    target.dispatchEvent(ev);
  };

  // 鼠标仍走原生 HTML5 DnD，不进触屏通道
  ptr('pointerdown', card1, { pointerType: 'mouse' });
  check('鼠标指针不触发触屏拖拽', dnd.isTouchDragging() === false);

  // 长按激活
  ptr('pointerdown', card1, { clientX: 0, clientY: 60 });
  check('按下瞬间尚未激活（长按未成形）', dnd.isTouchDragging() === false);
  await wait(320);
  check('长按后进入拖拽态', dnd.isTouchDragging() === true);
  check('被拖卡片带 dragging 标记', card1.classList.contains('dragging'));

  // 落位后松手：走的是与鼠标同一套移动逻辑，并带上乐观锁版本号
  let movePayload = null;
  apiMod.api.move = async (id, payload) => {
    movePayload = { id, ...payload };
    return { moved: true };
  };
  s.issues = s.issues.map((i) => (i.id === 1 ? { ...i, version: 7 } : i));
  notify();

  ptr('pointermove', card1, { clientX: 0, clientY: 60 });
  ptr('pointerup', card1, { clientX: 0, clientY: 60 });
  await wait(60);

  check('松手后调用了移动接口', movePayload !== null, JSON.stringify(movePayload));
  check(
    '落位列取自占位块所在列',
    Boolean(movePayload && movePayload.toStatus === 'backlog'),
    movePayload && movePayload.toStatus,
  );
  check(
    '移动请求携带乐观锁版本号',
    movePayload && movePayload.expectedVersion === 7,
    String(movePayload && movePayload.expectedVersion),
  );
  check('松手后退出拖拽态', dnd.isTouchDragging() === false);
  check('卡片不再带 dragging 标记', card1.classList.contains('dragging') === false);

  // 长按未成形就滑动 → 判定为页面滚动
  ptr('pointerdown', card1, { clientX: 0, clientY: 60 });
  ptr('pointermove', card1, { clientX: 0, clientY: 200 });
  await wait(320);
  check('短按滑动视为滚动，不激活拖拽', dnd.isTouchDragging() === false);
  ptr('pointerup', card1, { clientX: 0, clientY: 200 });
  check('滚动手势结束后卡片未被置灰', card1.classList.contains('dragging') === false);
}

console.log('\n--- 14. 批量选择与操作条 ---');
{
  s.filters.keyword = '';
  s.filters.assignee.clear();
  s.selection.clear();
  notify();

  const bar = $('#batchBar');
  const pick = (id) => document.querySelector(`.card[data-id="${id}"] .card-pick`);

  check('未勾选时批量条隐藏', bar.hidden === true);
  check(
    '每张卡片都有复选框',
    [1, 2, 3, 4, 5].every((id) => Boolean(pick(id))),
  );

  pick(1).click();
  await wait(20);
  check('勾选后进入 selection', s.selection.has(1));
  check('勾选后批量条出现', bar.hidden === false);
  check('计数显示「已选 1 项」', $('#batchCount').textContent === '已选 1 项', $('#batchCount').textContent);
  check(
    '卡片带上 selected 标记',
    document.querySelector('.card[data-id="1"]').classList.contains('selected'),
  );

  pick(2).click();
  await wait(20);
  check('再勾选一张后计数为 2', $('#batchCount').textContent === '已选 2 项', $('#batchCount').textContent);

  // 列头全选：只勾选本列当前可见的卡片
  const colPick = document.querySelector('.column[data-status="backlog"] .col-pick');
  colPick.click();
  await wait(20);
  check('列头全选勾选本列可见卡片', s.selection.has(5), [...s.selection].join(','));
  colPick.click();
  await wait(20);
  check('再次点击列头取消本列勾选', s.selection.has(5) === false, [...s.selection].join(','));

  // 批量移动
  let moveArgs = null;
  const origBatchMove = apiMod.api.batchMove;
  apiMod.api.batchMove = async (items, payload) => {
    moveArgs = { items, ...payload };
    return { moved: items.length, ids: items.map((it) => it.id), failed: [] };
  };
  $('#batchStatus').value = 'done';
  $('#batchMove').click();
  await wait(80);

  check('批量移动调用了批量接口', moveArgs !== null, JSON.stringify(moveArgs));
  check(
    '批量移动带上全部选中 id',
    JSON.stringify(moveArgs?.items?.map((it) => it.id)) === JSON.stringify([1, 2]),
    JSON.stringify(moveArgs?.items),
  );
  check(
    '批量移动逐卡携带乐观锁版本号',
    moveArgs?.items?.every((it) => Number.isInteger(it.expectedVersion)) === true,
    JSON.stringify(moveArgs?.items),
  );
  check('批量移动目标列取自下拉', moveArgs?.toStatus === 'done', String(moveArgs?.toStatus));
  check('成功后清空勾选', s.selection.size === 0, String(s.selection.size));
  check('清空后批量条收起', bar.hidden === true);
  apiMod.api.batchMove = origBatchMove;

  // 批量删除：必须走二次确认
  s.selection.add(3);
  notify();
  let removeIds = null;
  const origBatchRemove = apiMod.api.batchRemove;
  apiMod.api.batchRemove = async (ids) => {
    removeIds = ids;
    return { deleted: ids.length, ids, failed: [] };
  };

  $('#batchDelete').click();
  await wait(30);
  check('批量删除先弹二次确认', $('#modalRoot').hidden === false && $('#modalConfirm').hidden === false);
  check('确认文案说明数量', /1/.test($('#confirmText').textContent), $('#confirmText').textContent);
  check('未确认前不调用删除接口', removeIds === null);

  $('#confirmOk').click();
  await wait(120);
  check(
    '确认后调用批量删除接口',
    JSON.stringify(removeIds) === JSON.stringify([3]),
    JSON.stringify(removeIds),
  );
  apiMod.api.batchRemove = origBatchRemove;

  // 取消选择
  s.selection.add(4);
  notify();
  $('#batchCancel').click();
  await wait(20);
  check('取消选择清空勾选', s.selection.size === 0, String(s.selection.size));
}

// ------------------------------------------------------------------
// issue board 核心能力：编号 / 类型 chip / 详情抽屉 / 「我的」筛选
// ------------------------------------------------------------------
console.log('\n--- issue board 核心能力 ---');
{
  const firstCard = document.querySelector('.column[data-status="in_progress"] .card');

  // 卡片编号与类型 chip
  check(
    '卡片标题带 #编号',
    firstCard?.querySelector('.card-no')?.textContent === '#1',
    firstCard?.querySelector('.card-no')?.textContent,
  );
  const typeChip = firstCard?.querySelector('.chip.type');
  check(
    '卡片渲染类型 chip',
    Boolean(typeChip) && typeChip.textContent.includes('任务'),
    typeChip?.textContent.trim(),
  );
  check(
    '类型 chip 样式类跟随类型',
    mkIssue(1).type === 'task' && typeChip.classList.contains('type-task'),
    typeChip?.className,
  );

  // 点编号/标题打开详情抽屉（mock 返回 issue + 评论）
  firstCard.querySelector('.card-open').click();
  await wait(150);
  check('点击卡片打开详情抽屉', document.querySelector('#drawerRoot').hidden === false);
  check(
    '抽屉显示 #编号与标题',
    document.querySelector('.drawer-no')?.textContent === '#1' &&
      document.querySelector('#drawerTitle')?.textContent === '任务1',
    document.querySelector('#drawerTitle')?.textContent,
  );
  check(
    '抽屉渲染 mock 评论',
    document.querySelectorAll('.comment').length === 1 &&
      document.querySelector('.comment-body')?.textContent === '来自 mock 的评论',
    String(document.querySelectorAll('.comment').length),
  );
  check(
    '他人评论不显示删除按钮',
    Boolean(document.querySelector('.comment')) && !document.querySelector('.comment .comment-del'),
  );

  // Esc 关闭抽屉
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(50);
  check('Esc 关闭详情抽屉', document.querySelector('#drawerRoot').hidden === true);

  // 「我的」按钮：按当前登录用户 id 过滤负责人
  const mineBtn = $('#btnMine');
  mineBtn.click();
  await wait(50);
  check(
    '「我的」筛选按登录用户 id 过滤',
    s.filters.assignee.has('1') && s.filters.assignee.size === 1,
    [...s.filters.assignee].join(','),
  );
  check('「我的」按钮激活态', mineBtn.getAttribute('aria-pressed') === 'true');
  check(
    'fixture 无指派给 tester 的卡，列表为空',
    document.querySelectorAll('.card').length === 0,
    String(document.querySelectorAll('.card').length),
  );
  mineBtn.click();
  await wait(50);
  check(
    '再次点击「我的」取消过滤',
    s.filters.assignee.size === 0 && document.querySelectorAll('.card').length === 5,
    String(document.querySelectorAll('.card').length),
  );
}

// ------------------------------------------------------------------
// 列表视图：切换 / 排序 / 分页（fixture 5 条不满一页，分页只验结构）
// ------------------------------------------------------------------
console.log('\n--- 列表视图 ---');
{
  $('#viewList').click();
  await wait(80);
  check(
    '切换到列表视图',
    document.querySelector('#board').hidden === true && !document.querySelector('#listView').hidden,
  );
  check(
    '列表渲染 5 行',
    document.querySelectorAll('.issue-table tbody tr').length === 5,
    String(document.querySelectorAll('.issue-table tbody tr').length),
  );
  check('卡片编号列存在', document.querySelector('.issue-table tbody .td-id .cell-no')?.textContent === '#1');

  // 点「优先级」排序：fixture 1 条 high / 2 条 medium / 2 条 low
  document.querySelector('th[data-sort="priority"]').click();
  await wait(80);
  const prios = [...document.querySelectorAll('.issue-table tbody .td-priority .chip')].map((c) =>
    c.textContent.trim(),
  );
  check(
    '按优先级升序排列',
    JSON.stringify(prios) === JSON.stringify(['高', '高', '中', '低', '低']),
    JSON.stringify(prios),
  );

  // 同列再点反转
  document.querySelector('th[data-sort="priority"]').click();
  await wait(80);
  const priosDesc = [...document.querySelectorAll('.issue-table tbody .td-priority .chip')].map((c) =>
    c.textContent.trim(),
  );
  check(
    '同列再点反向排列',
    JSON.stringify(priosDesc) === JSON.stringify(['低', '低', '中', '高', '高']),
    JSON.stringify(priosDesc),
  );

  // 列表点标题打开抽屉
  document.querySelector('.issue-table tbody .card-open').click();
  await wait(150);
  check('列表点标题打开抽屉', document.querySelector('#drawerRoot').hidden === false);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(50);

  // 筛选在列表视图同样生效
  s.filters.keyword = '任务2';
  notify();
  await wait(80);
  check(
    '列表视图筛选生效（关键词命中 1 行）',
    document.querySelectorAll('.issue-table tbody tr').length === 1,
    String(document.querySelectorAll('.issue-table tbody tr').length),
  );
  s.filters.keyword = '';
  notify();

  // 切回看板
  $('#viewBoard').click();
  await wait(80);
  check(
    '切回看板视图',
    document.querySelector('#board').hidden === false && document.querySelector('#listView').hidden === true,
  );
}

// ------------------------------------------------------------------
// 多看板 workspace：切换 / 新建 / 删除 / 跨标签跟随
// ------------------------------------------------------------------
console.log('\n--- 多看板 workspace ---');
{
  // 记录 issues 请求的 URL，验证 boardId 透传
  const baseFetch = globalThis.fetch;
  const issueUrls = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/api/issues')) issueUrls.push(String(url));
    return baseFetch(url, opts);
  };
  window.fetch = globalThis.fetch;

  const boardSwitch = $('#boardSwitch');
  const boardLabel = $('#boardLabel');
  const panelBoard = $('#panelBoard');

  check('登录后看板切换器可见', boardSwitch.hidden === false);
  check('默认落在默认看板', boardLabel.textContent === '默认看板', boardLabel.textContent);

  // 面板内容
  boardSwitch.querySelector('.drop-trigger').click();
  await wait(30);
  check('点击触发器展开看板面板', panelBoard.classList.contains('open'));
  const boardOpts = () => [...panelBoard.querySelectorAll('[data-board-id]')];
  check('面板列出两块看板', boardOpts().length === 2, String(boardOpts().length));
  check(
    '看板选项带任务计数',
    boardOpts()[0].querySelector('.board-opt-count')?.textContent === '5',
    boardOpts()[0].textContent.trim(),
  );
  check('面板有「新建看板」入口', Boolean(panelBoard.querySelector('[data-board-create]')));
  check(
    '删除入口只出现在 owner 的板上（viewer 板没有）',
    panelBoard.querySelectorAll('[data-board-del]').length === 1 &&
      Boolean(panelBoard.querySelector('[data-board-del="1"]')),
    String(panelBoard.querySelectorAll('[data-board-del]').length),
  );

  // 切换到「产品规划」（空看板）
  boardOpts()
    .find((o) => o.dataset.boardId === '2')
    .click();
  await wait(120);
  check('切换后触发器文案更新', boardLabel.textContent === '产品规划', boardLabel.textContent);
  check(
    '看板切换带 boardId 拉取',
    issueUrls.some((u) => u.includes('boardId=2')),
    issueUrls.join(' | '),
  );
  check(
    '空看板渲染出空列状态',
    document.querySelectorAll('.col-empty').length === 5 && cardCount() === 0,
    String(cardCount()),
  );
  check(
    '当前看板 id 写入 localStorage',
    window.localStorage.getItem('issue-board:boardId') === '2',
    String(window.localStorage.getItem('issue-board:boardId')),
  );

  // 切回默认看板
  boardSwitch.querySelector('.drop-trigger').click();
  await wait(30);
  boardOpts()
    .find((o) => o.dataset.boardId === '1')
    .click();
  await wait(120);
  check('切回后恢复 5 张卡片', cardCount() === 5, String(cardCount()));

  // 新建看板：弹窗 → 创建成功 → 自动切换
  boardSwitch.querySelector('.drop-trigger').click();
  await wait(30);
  panelBoard.querySelector('[data-board-create]').click();
  await wait(30);
  check('新建看板弹窗打开', $('#modalRoot').hidden === false && $('#modalBoard').hidden === false);
  const boardForm = $('#boardForm');
  boardForm.elements.namedItem('name').value = '新领域';
  boardForm.querySelector('button[type="submit"]').click();
  await wait(200);
  check('创建后自动切换到新看板', boardLabel.textContent === '新领域', boardLabel.textContent);
  check('创建后看板列表有 3 块', s.boards.length === 3, String(s.boards.length));
  check('新看板任务为空', cardCount() === 0, String(cardCount()));

  // 删除看板：二次确认 → 当前板被删时自动回落
  boardSwitch.querySelector('.drop-trigger').click();
  await wait(30);
  panelBoard.querySelector('[data-board-del="3"]').click();
  await wait(30);
  check('删除看板先弹二次确认', $('#modalRoot').hidden === false && $('#modalConfirm').hidden === false);
  check(
    '确认文案说明级联删除',
    /新领域/.test($('#confirmText').textContent) && /一并删除/.test($('#confirmText').textContent),
    $('#confirmText').textContent,
  );
  $('#confirmOk').click();
  await wait(200);
  check('删除后看板列表回到 2 块', s.boards.length === 2, String(s.boards.length));
  check('被删的是当前板时自动回落到第一块', boardLabel.textContent === '默认看板', boardLabel.textContent);
  check('回落到默认看板后任务恢复 5 张', cardCount() === 5, String(cardCount()));

  // 跨标签页跟随：storage 事件带看板 id
  const ev2 = new window.Event('storage');
  ev2.key = 'issue-board:boardId';
  ev2.newValue = '2';
  window.dispatchEvent(ev2);
  await wait(120);
  check('其他标签页切换看板时本页跟随', boardLabel.textContent === '产品规划', boardLabel.textContent);
  const ev3 = new window.Event('storage');
  ev3.key = 'issue-board:boardId';
  ev3.newValue = '1';
  window.dispatchEvent(ev3);
  await wait(120);
  check(
    '跟随切回默认看板',
    boardLabel.textContent === '默认看板' && cardCount() === 5,
    boardLabel.textContent,
  );

  globalThis.fetch = baseFetch;
  window.fetch = baseFetch;
}

// ------------------------------------------------------------------
// toast 去重：相同文案不堆叠（轮询失败等场景会连续弹同一条）
// ------------------------------------------------------------------
console.log('\n--- 看板成员与权限（前端入口收敛） ---');
{
  // viewer 板补一张卡（多看板段已结束，不影响其空板断言）
  FIXTURE.push(mkIssue(6, { boardId: 2, title: '规划卡A', status: 'planning', position: 0 }));
  // owner（默认看板）：新建/导出可见，面板有成员管理与删除入口
  check('owner 可见新建按钮', $('#btnNew').hidden === false);
  check('owner 可见导出按钮', $('#btnExport').hidden === false);
  document.querySelector('#boardSwitch .drop-trigger').click();
  await wait(30);
  check('owner 面板有成员管理入口', Boolean(document.querySelector('[data-board-members]')));

  // 打开成员管理弹窗：mock 成员 = tester(owner)
  document.querySelector('[data-board-members]').click();
  await wait(150);
  check('成员弹窗打开', $('#modalRoot').hidden === false && !$('#modalMembers').hidden);
  check(
    '成员列表渲染 owner 角色',
    Boolean(document.querySelector('#membersList .member-row .member-role')),
    $('#membersList').innerHTML.slice(0, 80),
  );
  check('owner 可见添加成员行', $('#memberAddRow').hidden === false);

  // 添加成员（周野 → member）→ 列表刷新出现两行
  $('#memberUser').value = '2';
  $('#memberAddBtn').click();
  await wait(150);
  check(
    '添加成员后列表刷新',
    document.querySelectorAll('#membersList .member-row').length === 2,
    String(document.querySelectorAll('#membersList .member-row').length),
  );

  // 移除成员（周野）
  document.querySelector('[data-remove-id="2"]').click();
  await wait(150);
  check(
    '移除成员后列表刷新',
    document.querySelectorAll('#membersList .member-row').length === 1,
    String(document.querySelectorAll('#membersList .member-row').length),
  );
  document.querySelector('#modalMembers [data-close="1"]').click();
  await wait(30);

  // 切到 viewer 板：写操作入口全部收敛，只读标识出现
  document.querySelector('#boardSwitch .drop-trigger').click();
  await wait(30);
  document.querySelector('[data-board-id="2"]').click();
  await wait(150);
  check('viewer 看板隐藏新建按钮', $('#btnNew').hidden === true);
  check('viewer 看板隐藏导出按钮', $('#btnExport').hidden === true);
  check(
    'viewer 面板无成员管理入口',
    Boolean(document.querySelector('#panelBoard [data-board-members]')) === false,
  );
  check(
    'viewer 板无删除入口（owner 板不受影响）',
    Boolean(document.querySelector('[data-board-del="2"]')) === false &&
      Boolean(document.querySelector('[data-board-del="1"]')),
  );
  check(
    'viewer 卡片无勾选框',
    document.querySelectorAll('.card-pick').length === 0,
    String(document.querySelectorAll('.card-pick').length),
  );
  check('viewer 卡片无编辑按钮', document.querySelectorAll('[data-act="edit"]').length === 0);
  check(
    'viewer 列头无全选框',
    [...document.querySelectorAll('.col-pick')].every((el) => el.hidden),
  );

  // viewer 打开抽屉：只读标识、无编辑按钮
  document.querySelector('.card .card-open').click();
  await wait(150);
  check(
    'viewer 抽屉显示只读标识',
    Boolean(document.querySelector('.drawer-head-actions .chip')),
    document.querySelector('.drawer-head-actions')?.textContent.trim(),
  );
  check('viewer 抽屉无编辑按钮', Boolean(document.querySelector('[data-drawer-act="edit"]')) === false);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(50);

  // 切回 owner 板：入口恢复
  document.querySelector('#boardSwitch .drop-trigger').click();
  await wait(30);
  document.querySelector('[data-board-id="1"]').click();
  await wait(150);
  check('切回 owner 板后新建按钮恢复', $('#btnNew').hidden === false);
  check(
    '切回 owner 板后卡片勾选框恢复',
    document.querySelectorAll('.card-pick').length === 5,
    String(document.querySelectorAll('.card-pick').length),
  );
}

console.log('\n--- Markdown 描述渲染（受限渲染器 + XSS 防护） ---');
{
  const md = await import('../shared/markdown.js');

  // 基础子集
  check(
    '段落渲染',
    md.renderMarkdown('第一行\n第二行') === '<p>第一行<br>第二行</p>',
    md.renderMarkdown('第一行\n第二行'),
  );
  check('标题渲染', md.renderMarkdown('## 标题') === '<h2>标题</h2>', md.renderMarkdown('## 标题'));
  check(
    '无序列表渲染',
    md.renderMarkdown('- a\n- b') === '<ul><li>a</li><li>b</li></ul>',
    md.renderMarkdown('- a\n- b'),
  );
  check(
    '有序列表渲染',
    md.renderMarkdown('1. a\n2. b') === '<ol><li>a</li><li>b</li></ol>',
    md.renderMarkdown('1. a\n2. b'),
  );
  check(
    '代码块渲染且内部不解析',
    md.renderMarkdown('```js\n**not bold**\n```') === '<pre><code class="lang-js">**not bold**</code></pre>',
    md.renderMarkdown('```js\n**not bold**\n```'),
  );
  check(
    '粗体斜体删除线',
    md.renderMarkdown('**b** *i* ~~s~~') === '<p><strong>b</strong> <em>i</em> <del>s</del></p>',
  );
  check(
    '行内代码不被二次加工',
    md.renderMarkdown('`**x**`') === '<p><code>**x**</code></p>',
    md.renderMarkdown('`**x**`'),
  );
  check(
    '引用渲染',
    md.renderMarkdown('> 提示语') === '<blockquote>提示语</blockquote>',
    md.renderMarkdown('> 提示语'),
  );
  check('分隔线渲染', md.renderMarkdown('---') === '<hr>');
  check(
    '链接渲染且带安全属性',
    md.renderMarkdown('[官网](https://example.com)') ===
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">官网</a></p>',
    md.renderMarkdown('[官网](https://example.com)'),
  );

  // XSS 防护：先转义后解析，任何注入都变成字面文本
  check(
    'script 标签被转义为字面文本',
    md.renderMarkdown('<script>alert(1)</script>') === '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    md.renderMarkdown('<script>alert(1)</script>'),
  );
  check(
    'img onerror 被转义',
    md.renderMarkdown('<img src=x onerror=alert(1)>').includes('&lt;img'),
    md.renderMarkdown('<img src=x onerror=alert(1)>'),
  );
  check(
    'javascript: 链接被拒绝（只留文字）',
    md.renderMarkdown('[点我](javascript:alert(1))') === '<p>[点我](javascript:alert(1))</p>',
    md.renderMarkdown('[点我](javascript:alert(1))'),
  );
  check('data: URL 同样被拒', md.renderMarkdown('[x](data:text/html,bad)').includes('<a') === false);
  check(
    '自动链接带 rel=noopener',
    md
      .renderMarkdown('访问 https://example.com 谢谢')
      .includes('<a href="https://example.com" target="_blank" rel="noopener noreferrer">'),
    md.renderMarkdown('访问 https://example.com 谢谢'),
  );
  check(
    '链接文本里的 HTML 也被转义',
    md.renderMarkdown('[<b>x</b>](https://e.com)').includes('&lt;b&gt;'),
    md.renderMarkdown('[<b>x</b>](https://e.com)'),
  );
  check('空输入返回空串', md.renderMarkdown('') === '' && md.renderMarkdown(null) === '');

  // 抽屉集成：markdown 描述渲染为结构化 HTML
  const mdIssue = mkIssue(7, {
    boardId: 1,
    title: 'MD描述卡',
    status: 'backlog',
    position: 5,
    description: '需求要点：\n- 支持**粗体**\n- 支持`代码`',
  });
  FIXTURE.push(mdIssue);
  s.issues.push(mdIssue);
  notify();
  const mdCard = [...document.querySelectorAll('.card .card-open')].find((c) =>
    c.textContent.includes('MD描述卡'),
  );
  mdCard.click();
  await wait(150);
  const descHtml = document.querySelector('#drawerRoot .drawer-desc')?.innerHTML || '';
  check(
    '抽屉描述按 markdown 渲染',
    descHtml.includes('<ul>') &&
      descHtml.includes('<strong>粗体</strong>') &&
      descHtml.includes('<code>代码</code>'),
    descHtml.slice(0, 160),
  );
  check('抽屉描述容器带 md-body 类', Boolean(document.querySelector('#drawerRoot .drawer-desc.md-body')));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(50);
}

console.log('\n--- 泳道（列内按标签/负责人分组） ---');
{
  const swim = await import('../shared/swimlane.js');
  const dndSw = await import('../public/src/dnd.js');

  // 纯函数：分组键与标题
  check('标签泳道键取首个标签', swim.laneKeyOf({ tags: ['a', 'b'] }, 'tag') === 'tag:a');
  check('无标签哨兵键', swim.laneKeyOf({ tags: [] }, 'tag') === 'tag:_none');
  check('负责人泳道键优先 userId', swim.laneKeyOf({ assigneeId: 3 }, 'assignee') === 'assignee:3');
  check(
    '未指派哨兵键',
    swim.laneKeyOf({ assigneeId: null, assignee: '周野' }, 'assignee') === 'assignee:_none',
  );
  check('关闭维度无键', swim.laneKeyOf({}, 'none') === 'none');
  check(
    '泳道标题：标签/无标签',
    swim.laneTitleOf('tag:后端') === '# 后端' && swim.laneTitleOf('tag:_none') === '无标签',
  );
  check(
    '泳道标题：负责人经映射解析',
    swim.laneTitleOf('assignee:2', (id) => (id === 2 ? '周野' : null)) === '周野' &&
      swim.laneTitleOf('assignee:9', () => null) === '用户 9',
  );

  // 默认关闭：无 lane 区块
  check('默认无泳道区块', document.querySelectorAll('#board .lane').length === 0);

  // 切换到标签维度
  $('#laneSelect').value = 'tag';
  $('#laneSelect').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(120);
  const lanes = [...document.querySelectorAll('#board .lane')];
  check('泳道开启后出现 lane 区块', lanes.length > 0, String(lanes.length));
  check('泳道持久化到 localStorage', window.localStorage.getItem('issue-board:laneDim') === 'tag');
  const backlogLanes = [...document.querySelectorAll('.column[data-status="backlog"] .lane')];
  const laneKeys = backlogLanes.map((l) => l.dataset.laneKey);
  check(
    'backlog 列按标签分区（工具/无标签）',
    laneKeys.includes('tag:工具') && laneKeys.includes('tag:_none'),
    laneKeys.join(','),
  );
  check(
    '泳道标题渲染（无标签）',
    backlogLanes.some((l) => l.querySelector('.lane-head')?.textContent === '无标签'),
  );
  const toolBody = backlogLanes.find((l) => l.dataset.laneKey === 'tag:工具')?.querySelector('.lane-body');
  const noneBody = backlogLanes.find((l) => l.dataset.laneKey === 'tag:_none')?.querySelector('.lane-body');
  check('卡片归入自身组（卡5 在 工具 组）', Boolean(toolBody?.querySelector('.card[data-id="5"]')));
  const noneIds = [...(noneBody?.querySelectorAll('.card') || [])].map((c) => c.dataset.id);
  check('无标签组聚合无标签卡（7）', JSON.stringify(noneIds) === JSON.stringify(['7']), noneIds.join(','));

  // 组内排序：补一张无标签卡(8) 移到 7 之后 → 无标签组内顺序变化，不串组
  const laneIssue = mkIssue(8, {
    boardId: 1,
    title: '泳道排序卡',
    status: 'backlog',
    position: 6,
    tags: [],
    assigneeId: 2,
    assignee: '周野',
  });
  FIXTURE.push(laneIssue);
  s.issues.push(laneIssue);
  notify();
  await wait(80);
  dndSw.applyMoveOptimistic(8, 'backlog', 7);
  await wait(80);
  const noneIdsAfter = [
    ...document.querySelectorAll('.column[data-status="backlog"] .lane[data-lane-key="tag:_none"] .card'),
  ].map((c) => c.dataset.id);
  check(
    '组内排序生效（8 排到 7 后）',
    JSON.stringify(noneIdsAfter) === JSON.stringify(['7', '8']),
    noneIdsAfter.join(','),
  );
  check(
    '组间不串（工具组仍只有卡5）',
    Boolean(
      document.querySelector(
        '.column[data-status="backlog"] .lane[data-lane-key="tag:工具"] .card[data-id="5"]',
      ),
    ),
  );

  // 跨组投放归位：乐观移动卡5 到无标签组的 8 之后 → 渲染仍归 工具 组
  dndSw.applyMoveOptimistic(5, 'backlog', 8);
  await wait(80);
  const fiveLane = document.querySelector('.card[data-id="5"]')?.closest('.lane')?.dataset.laneKey;
  check('跨组投放后卡片归位自身组（数据不改组）', fiveLane === 'tag:工具', String(fiveLane));
  s.drag = null;
  notify();
  await wait(80);

  // 触屏拖拽：占位落在自身组 lane，afterId 取组内最后一张
  {
    // 复位：把卡5 移回 backlog 首、卡7 移回末，状态可预期
    s.issues = s.issues.map((i) => (i.id === 5 ? { ...i, status: 'backlog' } : i));
    notify();
    const apiMod2 = await import('../public/src/api.js');
    let movePayload2 = null;
    const origMove2 = apiMod2.api.move;
    apiMod2.api.move = async (id, payload) => {
      movePayload2 = { id, ...payload };
      return { moved: true };
    };
    const card5 = document.querySelector('.column[data-status="backlog"] .card[data-id="5"]');
    const ptr2 = (type, target, opts = {}) => {
      const ev = new window.Event(type, { bubbles: true, cancelable: true });
      Object.assign(ev, { pointerType: 'touch', pointerId: 9, clientX: 0, clientY: 0, ...opts });
      target.dispatchEvent(ev);
    };
    ptr2('pointerdown', card5, { clientX: 0, clientY: 60 });
    await wait(320);
    ptr2('pointermove', card5, { clientX: 0, clientY: 60 });
    // 指针悬到别组 lane（无标签组）也该落在自身组（工具组）
    const noneLane = document.querySelector(
      '.column[data-status="backlog"] .lane[data-lane-key="tag:_none"]',
    );
    noneLane?.classList.add('drag-over');
    ptr2('pointermove', noneLane || card5, { clientX: 0, clientY: 60 });
    const placeholderIn = document.querySelector('#board .placeholder')?.closest('.lane')?.dataset.laneKey;
    ptr2('pointerup', card5, { clientX: 0, clientY: 60 });
    await wait(60);
    check('触屏泳道：占位始终落在自身组', placeholderIn === 'tag:工具', String(placeholderIn));
    // 卡5 所在工具组在 backlog 列内是唯一一张 → 落组内只有自身 → afterId 为 null（组首）或自身
    const toolIds = [
      ...document.querySelectorAll('.column[data-status="backlog"] .lane[data-lane-key="tag:工具"] .card'),
    ].map((c) => Number(c.dataset.id));
    check(
      '触屏泳道：落位在自身组内（afterId 为组内合法位置）',
      movePayload2 !== null &&
        movePayload2.toStatus === 'backlog' &&
        (movePayload2.afterId === null || toolIds.includes(movePayload2.afterId)),
      JSON.stringify({ payload: movePayload2, toolIds }),
    );
    apiMod2.api.move = origMove2;
  }

  // 切到负责人维度：未指派/负责人组
  $('#laneSelect').value = 'assignee';
  $('#laneSelect').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(120);
  const aLanes = [...document.querySelectorAll('.column[data-status="backlog"] .lane')].map(
    (l) => l.dataset.laneKey,
  );
  check(
    '负责人维度分区（未指派组 + 周野组）',
    aLanes.includes('assignee:_none') && aLanes.includes('assignee:2'),
    aLanes.join(','),
  );
  check(
    '负责人组卡片归组（卡8 assigneeId=2）',
    Boolean(
      document.querySelector(
        '.column[data-status="backlog"] .lane[data-lane-key="assignee:2"] .card[data-id="8"]',
      ),
    ),
  );
  check(
    '负责人组标题经用户映射',
    [...document.querySelectorAll('.column[data-status="backlog"] .lane-head')].some(
      (h) => h.textContent === '周野',
    ),
    [...document.querySelectorAll('.column[data-status="backlog"] .lane-head')]
      .map((h) => h.textContent)
      .join(','),
  );

  // 关闭泳道：恢复平铺
  $('#laneSelect').value = 'none';
  $('#laneSelect').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(120);
  check('关闭泳道恢复平铺（无 lane）', document.querySelectorAll('#board .lane').length === 0);
  check(
    '关闭后卡片仍正常渲染（backlog 3 张、无 lane 包裹）',
    document.querySelectorAll('.column[data-status="backlog"] .card').length === 3 &&
      !document.querySelector('.column[data-status="backlog"] .lane-body') &&
      document.querySelector('.column[data-status="backlog"] .col-body .card[data-id="5"]') !== null,
    `${document.querySelectorAll('.column[data-status="backlog"] .card').length} cards`,
  );
  check('泳道偏好持久化', window.localStorage.getItem('issue-board:laneDim') === 'none');
}

console.log('\n--- toast 去重 ---');
{
  const toastMod = await import('../public/src/toast.js');
  // 清掉此前用例残留且仍在存活期的 toast，保证计数断言确定性
  document.querySelector('#toastRoot').innerHTML = '';
  toastMod.toast('加载失败：请求过于频繁', 'error');
  toastMod.toast('加载失败：请求过于频繁', 'error');
  toastMod.toast('加载失败：请求过于频繁', 'error');
  check(
    '相同文案只保留一条',
    document.querySelectorAll('#toastRoot .toast').length === 1,
    String(document.querySelectorAll('#toastRoot .toast').length),
  );
  toastMod.toast('另一条提示');
  check(
    '不同文案正常并存',
    document.querySelectorAll('#toastRoot .toast').length === 2,
    String(document.querySelectorAll('#toastRoot .toast').length),
  );
  check('相同文案保留的是新类型', document.querySelector('#toastRoot .toast').dataset.type === 'error');
}

// ------------------------------------------------------------------
// CSV 导出：shared 纯函数（转义/匹配口径）+ 下载触发
// ------------------------------------------------------------------
console.log('\n--- CSV 导出 ---');
{
  const csvMod = await import('../shared/csv.js');
  const filterMod = await import('../shared/issue-filters.js');

  check(
    'toCsv 简单行直接拼接',
    csvMod.toCsv([
      ['a', 'b'],
      ['1', '2'],
    ]) === 'a,b\r\n1,2',
  );
  check(
    'toCsv 转义逗号/引号/换行',
    csvMod.toCsv([['含,逗号', '含"引号', '含\n换行', '普通']]) === '"含,逗号","含""引号","含\n换行",普通',
    csvMod.toCsv([['含,逗号', '含"引号', '含\n换行', '普通']]),
  );
  check('toCsv null/undefined 输出空字段', csvMod.toCsv([[null, undefined, 0]]) === ',,0');

  // 匹配口径：与 Web 端看板同一份（shared/issue-filters.js）
  const issue = {
    id: 7,
    title: '修复登录超时',
    description: '会话 7 天过期',
    priority: 'high',
    assignee: '',
    assigneeId: 3,
    tags: ['后端'],
    logs: [{ actor: 'ai:bot' }],
  };
  check('关键词命中 #编号', filterMod.matchesFilters(issue, { keyword: '#7' }) === true);
  check('关键词命中描述', filterMod.matchesFilters(issue, { keyword: '过期' }) === true);
  check(
    '多维度 AND（优先级+标签）',
    filterMod.matchesFilters(issue, { priority: new Set(['high']), tag: new Set(['后端']) }) === true,
  );
  check('优先级不匹配被排除', filterMod.matchesFilters(issue, { priority: new Set(['low']) }) === false);
  check(
    'assignee 键取用户 id',
    filterMod.assigneeKey(issue) === '3' &&
      filterMod.matchesFilters(issue, { assignee: new Set(['3']) }) === true,
  );
  check('未指派卡命中 _none 哨兵', filterMod.assigneeKey({ assignee: '', assigneeId: null }) === '_none');
  check('aiOnly 命中 AI 操作痕', filterMod.matchesFilters(issue, { aiOnly: true }) === true);
  check(
    '无 AI 痕的卡被 aiOnly 排除',
    filterMod.matchesFilters({ ...issue, logs: [] }, { aiOnly: true }) === false,
  );

  // 查询参数解析：与 Web 端一致的语义
  const parsed = filterMod.parseExportFilters(new URLSearchParams('q=%237&priority=high,low&tag=&aiOnly=1'));
  check(
    'parseExportFilters 解析 q/多选/aiOnly',
    parsed.keyword === '#7' &&
      parsed.priority.has('high') &&
      parsed.priority.has('low') &&
      parsed.tag.size === 0 &&
      parsed.aiOnly === true,
    JSON.stringify(parsed),
  );

  // 下载触发：stub blob URL 与 a.click，点击按钮走完整链路
  globalThis.HTMLAnchorElement = window.HTMLAnchorElement;
  const origCreate = window.URL.createObjectURL;
  const origRevoke = window.URL.revokeObjectURL;
  window.URL.createObjectURL = () => 'blob:mock-url';
  window.URL.revokeObjectURL = () => {};
  let clicked = false;
  let downloadName = '';
  window.HTMLAnchorElement.prototype.click = function () {
    clicked = true;
    downloadName = this.download;
  };

  // 记录导出请求 URL（与多看板段的 spy 独立）
  const baseFetch2 = globalThis.fetch;
  const exportUrls = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/api/export/csv')) exportUrls.push(String(url));
    return baseFetch2(url, opts);
  };
  window.fetch = globalThis.fetch;

  // 带筛选：只导出高优先级（fixture 中 2 张 high）
  document.querySelector('#toastRoot').innerHTML = '';
  s.filters.priority = new Set(['high']);
  notify();
  $('#btnExport').disabled = false;
  $('#btnExport').click();
  await wait(150);

  check(
    '导出触发浏览器下载',
    clicked === true && downloadName === 'cloudissue-默认看板-2026-11-05.csv',
    downloadName,
  );
  check(
    '导出请求携带 boardId 与筛选参数',
    exportUrls.some((u) => u.includes('boardId=1') && u.includes('priority=high')),
    exportUrls.join(' | '),
  );
  const expectCount = FIXTURE.filter((i) => i.boardId === 1).length;
  check(
    '导出成功 toast 带数量',
    document.querySelector('#toastRoot .toast')?.textContent ===
      `已导出 ${expectCount} 个任务：cloudissue-默认看板-2026-11-05.csv`,
    document.querySelector('#toastRoot .toast')?.textContent,
  );

  s.filters.priority.clear();
  notify();
  globalThis.fetch = baseFetch2;
  window.fetch = baseFetch2;
  window.URL.createObjectURL = origCreate;
  window.URL.revokeObjectURL = origRevoke;
}

// ------------------------------------------------------------------
// CSS 静态回归：带 display 值的类不能让 [hidden] 失效。
// jsdom 不加载外部样式表、无布局引擎，computed style 测不到这类问题，
// 因此做源码级断言。此前已两次踩坑（.modal-root / .fm-row 覆盖
// UA 的 [hidden]{display:none}），新增同名坑时这里会红。
// ------------------------------------------------------------------
console.log('\n--- CSS 回归：[hidden] 与 display 规则 ---');
const stylesCss = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const hiddenGuards = [
  { selector: '.modal-root', display: 'grid' },
  { selector: '.fm-row', display: 'flex' },
  { selector: '.batch-bar', display: 'flex' },
];
for (const { selector, display } of hiddenGuards) {
  const esc = selector.replace('.', '\\.');
  const baseRule = new RegExp(`${esc}\\s*\\{[^}]*display:\\s*${display}`, 's');
  if (baseRule.test(stylesCss)) {
    const guard = new RegExp(`${esc}\\[hidden\\]\\s*\\{[^}]*display:\\s*none`, 's');
    check(`${selector}[hidden] 存在对应隐藏规则`, guard.test(stylesCss));
  } else {
    check(`${selector} 未设置 display（无需补救规则）`, true);
  }
}

console.log(`\n=====================================`);
console.log(`  UI 冒烟：通过 ${pass} 项，失败 ${fail} 项`);
console.log(`=====================================\n`);
process.exit(fail ? 1 : 0);
