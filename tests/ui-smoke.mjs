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

console.log(`\n=====================================`);
console.log(`  UI 冒烟：通过 ${pass} 项，失败 ${fail} 项`);
console.log(`=====================================\n`);
process.exit(fail ? 1 : 0);
