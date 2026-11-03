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
    description: `描述${id}`,
    priority: 'medium',
    assignee: '周野',
    tags: [],
    dueDate: ymd(5),
    status: 'backlog',
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
globalThis.CustomEvent = window.CustomEvent;
globalThis.DataTransfer = window.DataTransfer;

globalThis.fetch = async (url) => {
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
  if (u.includes('/api/issues')) {
    return { ok: true, status: 200, json: async () => ({ issues: FIXTURE }) };
  }
  throw new Error('unexpected url ' + url);
};
window.fetch = globalThis.fetch;

const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));

let modals;
let state;
let render;

try {
  render = await import('../public/src/render.js');
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
const countText = (status) =>
  $(`.column[data-status="${status}"] .col-count`).textContent;
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
  columns.map((c) => c.dataset.status).join(',')
);
check('失败列带 is-fail 标记', Boolean($('.column.is-fail')));

console.log('\n--- 2. 卡片渲染 ---');
check('渲染出 5 张卡片', cardCount() === 5, String(cardCount()));
check(
  '卡片可拖拽',
  [...document.querySelectorAll('.card')].every((c) => c.getAttribute('draggable') === 'true')
);
check(
  '卡片带优先级标识',
  [...document.querySelectorAll('.card')].every((c) => Boolean(c.dataset.priority))
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
  opts.map((o) => o.value).join(',')
);
check(
  '状态选项文案为中文列名',
  JSON.stringify(opts.map((o) => o.textContent.trim())) ===
    JSON.stringify(['未规划', '规划中', '进行中', '已完成', '失败']),
  opts.map((o) => o.textContent.trim()).join(',')
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
  `${callsBeforeEvent} -> ${listCalls}`
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
check(
  '切回前台时兜底刷新一次',
  listCalls > callsBeforeVisible,
  `${callsBeforeVisible} -> ${listCalls}`
);

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
    movePayload && movePayload.toStatus
  );
  check(
    '移动请求携带乐观锁版本号',
    movePayload && movePayload.expectedVersion === 7,
    String(movePayload && movePayload.expectedVersion)
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
  check('每张卡片都有复选框', [1, 2, 3, 4, 5].every((id) => Boolean(pick(id))));

  pick(1).click();
  await wait(20);
  check('勾选后进入 selection', s.selection.has(1));
  check('勾选后批量条出现', bar.hidden === false);
  check('计数显示「已选 1 项」', $('#batchCount').textContent === '已选 1 项', $('#batchCount').textContent);
  check('卡片带上 selected 标记', document.querySelector('.card[data-id="1"]').classList.contains('selected'));

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
    JSON.stringify(moveArgs?.items)
  );
  check(
    '批量移动逐卡携带乐观锁版本号',
    moveArgs?.items?.every((it) => Number.isInteger(it.expectedVersion)) === true,
    JSON.stringify(moveArgs?.items)
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
  check('确认后调用批量删除接口', JSON.stringify(removeIds) === JSON.stringify([3]), JSON.stringify(removeIds));
  apiMod.api.batchRemove = origBatchRemove;

  // 取消选择
  s.selection.add(4);
  notify();
  $('#batchCancel').click();
  await wait(20);
  check('取消选择清空勾选', s.selection.size === 0, String(s.selection.size));
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
