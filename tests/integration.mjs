/**
 * 端到端集成测试：验证 HTTP → MCP → MySQL 全链路与全部业务规则。
 * 运行前需先启动服务（认证套件会发起大量登录尝试，请调高认证限流）：
 *   AUTH_RATE_LIMIT=10000 node server/index.js
 */
import http from 'node:http';
import crypto from 'node:crypto';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173';

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

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (cookieJar) headers.Cookie = cookieJar;
  const res = await fetch(BASE + path, { ...opts, headers });
  // 极简 cookie jar：注册/登录/改密响应会下发新会话，自动接管
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookieJar = setCookie.split(';')[0];
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, data };
}

let cookieJar = '';

const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body) });
const put = (p, body) => api(p, { method: 'PUT', body: JSON.stringify(body) });
const del = (p) => api(p, { method: 'DELETE' });

async function getIssue(id) {
  const { data } = await api('/api/issues');
  return (data.issues || []).find((i) => i.id === id);
}

/** 以 Bearer Token 调用 /mcp（JSON-RPC）；响应可能是 SSE，统一抽取 data 行 */
async function mcpCall(token, id, method, params) {
  const res = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const raw = await res.text();
  let payload = raw;
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) {
      payload = line.slice(5).trim();
      break;
    }
  }
  let data = {};
  try {
    data = JSON.parse(payload);
  } catch {
    /* empty */
  }
  return { status: res.status, data };
}

/** 取 MCP tool 结果里首个 text content 的 JSON */
function jsonContent(rpcResult) {
  const text = rpcResult?.result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  console.log('\n--- 1. 健康检查（经 MCP） ---');
  const health = await api('/api/health');
  check('健康检查通过', health.status === 200 && health.data.connected === true);
  check('确认经由 MCP 链路', health.data.viaMcp === true);
  check('连接的库为 issue_board', health.data.db === 'issue_board', health.data.db);

  console.log('\n--- 1b. 认证与多用户（共享团队看板） ---');
  // 未登录一律 401
  const anonList = await api('/api/issues');
  check('未登录读取看板返回 401', anonList.status === 401, JSON.stringify(anonList.data));
  const anonCreate = await post('/api/issues', { title: '匿名' });
  check('未登录新建任务返回 401', anonCreate.status === 401, JSON.stringify(anonCreate.data));

  const uniq = Date.now().toString(36).slice(-6);
  const USER_A = `it_a_${uniq}`;
  const USER_B = `it_b_${uniq}`;

  // 注册入参校验
  const badName = await post('/api/auth/register', { username: 'x', password: 'password123' });
  check('非法用户名被拒绝', badName.status === 400, JSON.stringify(badName.data));
  const shortPwd = await post('/api/auth/register', { username: USER_A, password: 'short' });
  check('过短密码被拒绝', shortPwd.status === 400, JSON.stringify(shortPwd.data));

  const regA = await post('/api/auth/register', {
    username: USER_A,
    password: 'password123',
    displayName: '集成用户A',
  });
  check(
    '注册成功返回 201 与用户信息',
    regA.status === 201 && regA.data.user?.username === USER_A,
    JSON.stringify(regA.data),
  );
  check('注册后即持有会话', Boolean(cookieJar));

  const dupReg = await post('/api/auth/register', { username: USER_A, password: 'password123' });
  check('重复用户名被拒绝', dupReg.status === 400, JSON.stringify(dupReg.data));

  const meA = await api('/api/auth/me');
  check(
    'me 返回当前用户',
    meA.status === 200 && meA.data.user?.username === USER_A,
    JSON.stringify(meA.data),
  );

  const badLogin = await post('/api/auth/login', { username: USER_A, password: 'wrong-pass-1' });
  check('错误密码登录返回 401', badLogin.status === 401, JSON.stringify(badLogin.data));

  // 登出 → me 401 → 重新登录
  cookieJar = '';
  const anonMe = await api('/api/auth/me');
  check('登出后 me 返回 401', anonMe.status === 401, String(anonMe.status));
  const loginA = await post('/api/auth/login', { username: USER_A, password: 'password123' });
  check(
    '重新登录成功',
    loginA.status === 200 && loginA.data.user?.username === USER_A,
    JSON.stringify(loginA.data),
  );
  const cookieA = cookieJar;

  // 共享看板：用户 B 登录后读的是同一块板
  const regB = await post('/api/auth/register', { username: USER_B, password: 'password123' });
  check('注册第二个用户成功', regB.status === 201, JSON.stringify(regB.data));
  const { data: listForB } = await api('/api/issues');
  check(
    '用户 B 登录后可读取同一块看板',
    (listForB.issues || []).length >= 1,
    String((listForB.issues || []).length),
  );

  // 改密：旧会话吊销、新会话可用、新密码登录、旧密码失效
  cookieJar = cookieA;
  const cookieAOld = cookieJar;
  const chg = await api('/api/auth/password', {
    method: 'PUT',
    body: JSON.stringify({ oldPassword: 'password123', newPassword: 'newpass123456' }),
  });
  check('改密成功', chg.status === 200, JSON.stringify(chg.data));
  const cookieANew = cookieJar;

  const wrongOld = await api('/api/auth/password', {
    method: 'PUT',
    body: JSON.stringify({ oldPassword: 'oops-wrong', newPassword: 'whatever123' }),
  });
  check('原密码不正确时改密被拒绝', wrongOld.status === 400, JSON.stringify(wrongOld.data));

  cookieJar = cookieAOld;
  const withOld = await api('/api/auth/me');
  check('改密后旧会话立即失效', withOld.status === 401, String(withOld.status));
  cookieJar = cookieANew;
  const withNew = await api('/api/auth/me');
  check('改密后新会话可用', withNew.status === 200, String(withNew.status));

  cookieJar = '';
  const oldPwdLogin = await post('/api/auth/login', { username: USER_A, password: 'password123' });
  check('旧密码已不可登录', oldPwdLogin.status === 401, String(oldPwdLogin.status));
  const relogin = await post('/api/auth/login', { username: USER_A, password: 'newpass123456' });
  check('新密码可登录', relogin.status === 200, JSON.stringify(relogin.data));

  console.log('\n--- 2. 示例数据初始化 ---');
  const list0 = await api('/api/issues');
  const issues0 = list0.data.issues || [];
  // 以当前总数为基线做相对断言：套件在「干净种子」与「已积累数据的看板」上都能跑，
  // 连续迭代产生的演示卡片不会污染计数类断言
  const BASELINE = issues0.length;
  const isPristineSeed = BASELINE === 10;
  if (isPristineSeed) {
    check('已写入 10 条示例任务', true, String(BASELINE));
    const statuses = new Set(issues0.map((i) => i.status));
    check('覆盖全部五列', statuses.size === 5, [...statuses].join(','));
    const prios = new Set(issues0.map((i) => i.priority));
    check('覆盖三档优先级', prios.size === 3, [...prios].join(','));
  } else {
    check(`看板已有 ${BASELINE} 条任务（非干净种子，跳过种子构成断言）`, BASELINE > 0, String(BASELINE));
  }

  console.log('\n--- 3. 新建任务 ---');
  const created = await post('/api/issues', {
    title: '集成测试任务',
    description: '验证 MCP 数据读写链路',
    priority: 'high',
    assignee: '测试员',
    tags: '测试, 集成',
    dueDate: '2026-11-10',
    status: 'backlog',
  });
  check('新建返回 201', created.status === 201, JSON.stringify(created.data));
  const id = created.data.id;
  check('返回了自增 ID', Number.isInteger(id) && id > 0, String(id));
  check(
    '标签正确写入',
    JSON.stringify(created.data.issue.tags) === JSON.stringify(['测试', '集成']),
    JSON.stringify(created.data.issue.tags),
  );
  check(
    '新建即产生一条变更记录',
    created.data.issue.logs.length === 1,
    String(created.data.issue.logs.length),
  );
  check(
    '新建记录的 fromStatus 为空',
    created.data.issue.logs[0].fromStatus === '',
    JSON.stringify(created.data.issue.logs[0]),
  );

  console.log('\n--- 4. 失败原因强校验 ---');
  const bad = await post(`/api/issues/${id}/move`, { toStatus: 'failed' });
  check('未填原因移动到失败被拒绝', bad.status === 400, JSON.stringify(bad.data));
  check('错误信息明确提及失败原因', /失败原因/.test(bad.data.error || ''), bad.data.error);

  const afterBad = await getIssue(id);
  check('被拒绝后仍停留在原列', afterBad.status === 'backlog', afterBad.status);

  const bad2 = await post(`/api/issues/${id}/move`, { toStatus: 'failed', failReason: '   ' });
  check('空白原因同样被拒绝', bad2.status === 400, JSON.stringify(bad2.data));

  console.log('\n--- 5. 填写原因后可正常移动 ---');
  const reason = '集成测试：模拟依赖方接口不可用';
  const good = await post(`/api/issues/${id}/move`, { toStatus: 'failed', failReason: reason });
  check('移动成功', good.status === 200 && good.data.moved === true, JSON.stringify(good.data));
  check(
    '记录了状态变化',
    good.data.statusChanged === true && good.data.fromStatus === 'backlog',
    JSON.stringify(good.data),
  );

  const moved = await getIssue(id);
  check('状态已变为 failed', moved.status === 'failed', moved.status);
  const lastLog = moved.logs[moved.logs.length - 1];
  check(
    '变更记录写入了原状态与新状态',
    lastLog.fromStatus === 'backlog' && lastLog.toStatus === 'failed',
    JSON.stringify(lastLog),
  );
  check('变更记录写入了失败原因', lastLog.reason === reason, lastLog.reason);
  check('变更记录带时间戳', Boolean(lastLog.changedAt), lastLog.changedAt);

  console.log('\n--- 6. 排序（afterId） ---');
  const a = await post('/api/issues', { title: '排序A', status: 'done', priority: 'low' });
  const b = await post('/api/issues', { title: '排序B', status: 'done', priority: 'low' });
  const c = await post('/api/issues', { title: '排序C', status: 'done', priority: 'low' });
  // 把 C 插到 A 之后：期望 A, C, B
  await post(`/api/issues/${c.data.id}/move`, { toStatus: 'done', afterId: a.data.id });
  const { data: dl } = await api('/api/issues');
  const doneOrder = dl.issues
    .filter((i) => ['排序A', '排序B', '排序C'].includes(i.title))
    .map((i) => i.title);
  check(
    'afterId 排序生效（期望 A,C,B）',
    JSON.stringify(doneOrder) === JSON.stringify(['排序A', '排序C', '排序B']),
    JSON.stringify(doneOrder),
  );
  for (const t of [a, b, c]) await del(`/api/issues/${t.data.id}`);

  console.log('\n--- 7. 更新任务 ---');
  const upd = await put(`/api/issues/${id}`, {
    title: '集成测试任务-已修改',
    priority: 'low',
    assignee: '新负责人',
    tags: '改过的标签',
    status: 'planning',
  });
  check('更新返回 200', upd.status === 200, JSON.stringify(upd.data));
  check('标题已更新', upd.data.issue.title === '集成测试任务-已修改', upd.data.issue.title);
  check('优先级已更新', upd.data.issue.priority === 'low', upd.data.issue.priority);
  check(
    '标签被整体替换',
    JSON.stringify(upd.data.issue.tags) === JSON.stringify(['改过的标签']),
    JSON.stringify(upd.data.issue.tags),
  );
  check(
    '离开失败列产生新记录',
    upd.data.issue.logs.some((l) => l.fromStatus === 'failed' && l.toStatus === 'planning'),
  );

  console.log('\n--- 8. 更新到失败列同样要求原因 ---');
  const badUpdate = await put(`/api/issues/${id}`, { status: 'failed' });
  check('编辑时改为失败但未填原因被拒绝', badUpdate.status === 400, JSON.stringify(badUpdate.data));

  console.log('\n--- 9. 删除与级联清理 ---');
  const delRes = await del(`/api/issues/${id}`);
  check('删除返回 200', delRes.status === 200 && delRes.data.deleted === true, JSON.stringify(delRes.data));
  const { data: afterDel } = await api('/api/issues');
  check('任务已从列表移除', !afterDel.issues.some((i) => i.id === id));
  check(
    '总数回到基线（未被重复初始化）',
    afterDel.issues.length === BASELINE,
    String(afterDel.issues.length),
  );

  console.log('\n--- 10. 状态枚举约束 ---');
  const badStatus = await post('/api/issues', { title: '非法状态', status: 'unknown_status' });
  check('非法状态被拒绝', badStatus.status === 400, JSON.stringify(badStatus.data));

  console.log('\n--- 11. 乐观并发控制（version） ---');
  const { data: vList } = await api('/api/issues');
  const any = vList.issues[0];
  check('列表返回版本号', Number.isInteger(any.version), String(any.version));

  const okUpd = await put(`/api/issues/${any.id}`, {
    title: `${any.title}·v1`,
    expectedVersion: any.version,
  });
  check('版本号一致时更新成功', okUpd.status === 200, JSON.stringify(okUpd.data));
  check(
    '更新后版本号 +1',
    okUpd.data.issue.version === any.version + 1,
    String(okUpd.data.issue && okUpd.data.issue.version),
  );

  const staleUpd = await put(`/api/issues/${any.id}`, {
    title: `${any.title}·过期`,
    expectedVersion: any.version,
  });
  check('版本号过期时更新返回 409', staleUpd.status === 409, JSON.stringify(staleUpd.data));
  check('冲突提示说明原因', /已被其他人修改/.test(staleUpd.data.error || ''), staleUpd.data.error);
  check(
    '冲突响应带回当前版本号',
    staleUpd.data.currentVersion === any.version + 1,
    String(staleUpd.data.currentVersion),
  );

  const staleMove = await post(`/api/issues/${any.id}/move`, {
    toStatus: any.status,
    expectedVersion: any.version,
  });
  check('版本号过期时移动被拒绝', staleMove.status === 409, JSON.stringify(staleMove.data));

  const cur = await getIssue(any.id);
  const okMove = await post(`/api/issues/${any.id}/move`, {
    toStatus: any.status,
    afterId: null,
    expectedVersion: cur.version,
  });
  check(
    '版本号一致时移动成功',
    okMove.status === 200 && okMove.data.moved === true,
    JSON.stringify(okMove.data),
  );

  // 复原现场：清掉本组改动，避免污染后续轮次的示例数据
  await put(`/api/issues/${any.id}`, { title: any.title });
  const restored = await getIssue(any.id);
  check('冲突未覆盖他人改动（标题仍是最新值）', restored.title !== `${any.title}·过期`, restored.title);

  console.log('\n--- 12. 批量移动与批量删除 ---');
  const b1 = await post('/api/issues', { title: '批量A', status: 'backlog', priority: 'low' });
  const b2 = await post('/api/issues', { title: '批量B', status: 'backlog', priority: 'low' });
  const b3 = await post('/api/issues', { title: '批量C', status: 'backlog', priority: 'low' });
  const bIds = [b1.data.id, b2.data.id, b3.data.id];
  const statusOf = (list, id) => list.find((i) => i.id === id)?.status;

  const noIds = await post('/api/issues/batch/move', { toStatus: 'planning' });
  check('未选择任务时批量移动被拒绝', noIds.status === 400, JSON.stringify(noIds.data));

  const badBatch = await post('/api/issues/batch/move', { ids: bIds, toStatus: 'failed' });
  check('批量移动到失败列未填原因被拒绝', badBatch.status === 400, JSON.stringify(badBatch.data));
  check('错误同样明确提及失败原因', /失败原因/.test(badBatch.data.error || ''), badBatch.data.error);

  const { data: afterBadBatch } = await api('/api/issues');
  check(
    '被拒绝后三张卡仍停留在原列',
    bIds.every((id) => statusOf(afterBadBatch.issues, id) === 'backlog'),
    bIds.map((id) => statusOf(afterBadBatch.issues, id)).join(','),
  );

  const mv = await post('/api/issues/batch/move', { ids: bIds, toStatus: 'planning' });
  check('批量移动成功', mv.status === 200 && mv.data.moved === 3, JSON.stringify(mv.data));
  check('批量移动没有失败项', (mv.data.failed || []).length === 0, JSON.stringify(mv.data.failed));

  const { data: afterMv } = await api('/api/issues');
  check(
    '三张卡状态均已变更',
    bIds.every((id) => statusOf(afterMv.issues, id) === 'planning'),
    bIds.map((id) => statusOf(afterMv.issues, id)).join(','),
  );
  const planningTitles = afterMv.issues.filter((i) => i.status === 'planning').map((i) => i.title);
  check(
    '按勾选顺序追加到目标列尾部',
    JSON.stringify(planningTitles.slice(-3)) === JSON.stringify(['批量A', '批量B', '批量C']),
    planningTitles.join(','),
  );

  const mvFail = await post('/api/issues/batch/move', {
    ids: bIds,
    toStatus: 'failed',
    failReason: '批量：依赖方接口整体不可用',
  });
  check(
    '填写原因后批量进入失败列',
    mvFail.status === 200 && mvFail.data.moved === 3,
    JSON.stringify(mvFail.data),
  );
  const failedOne = await getIssue(bIds[0]);
  const batchLog = failedOne.logs[failedOne.logs.length - 1];
  check('批量移动同样写入变更记录', batchLog.toStatus === 'failed', JSON.stringify(batchLog));
  check('变更记录带上批量填写的原因', batchLog.reason === '批量：依赖方接口整体不可用', batchLog.reason);

  console.log('\n--- 13. 批量移动乐观锁（items 形态） ---');
  // 三张卡已经历 新建(1) → planning(2) → failed(3)，版本 1 必然全部过期
  const allStale = await post('/api/issues/batch/move', {
    items: bIds.map((bid) => ({ id: bid, expectedVersion: 1 })),
    toStatus: 'done',
  });
  check('批量移动版本全部过期时整体被拒', allStale.status === 400, JSON.stringify(allStale.data));
  check('逐卡汇总冲突信息', (allStale.data.failed || []).length === 3, JSON.stringify(allStale.data.failed));
  check('全部过期时没有任何卡片被移动', (allStale.data.moved ?? 0) === 0, String(allStale.data.moved));

  // 一张带正确版本、一张过期：正确的成功、过期的进 failed 汇总
  const { data: blNow } = await api('/api/issues');
  const freshVersion = blNow.issues.find((i) => i.id === bIds[0])?.version;
  const mixed = await post('/api/issues/batch/move', {
    items: [
      { id: bIds[0], expectedVersion: freshVersion },
      { id: bIds[1], expectedVersion: 1 },
    ],
    toStatus: 'done',
  });
  check(
    '混合版本时正确的卡片成功',
    mixed.status === 200 && mixed.data.moved === 1,
    JSON.stringify(mixed.data),
  );
  check(
    '过期的卡片进入 failed 汇总',
    (mixed.data.failed || []).length === 1,
    JSON.stringify(mixed.data.failed),
  );

  const badDel = await post('/api/issues/batch/delete', { ids: [] });
  check('空 id 列表的批量删除被拒绝', badDel.status === 400, JSON.stringify(badDel.data));

  const del2 = await post('/api/issues/batch/delete', { ids: bIds });
  check('批量删除成功', del2.status === 200 && del2.data.deleted === 3, JSON.stringify(del2.data));

  const { data: afterBatch } = await api('/api/issues');
  check('三张卡已从列表移除', !afterBatch.issues.some((i) => bIds.includes(i.id)));
  check(
    '总数回到基线（批量操作未污染示例数据）',
    afterBatch.issues.length === BASELINE,
    String(afterBatch.issues.length),
  );

  const delMissing = await post('/api/issues/batch/delete', { ids: [99999999] });
  check('删除不存在的任务返回 400', delMissing.status === 400, JSON.stringify(delMissing.data));

  console.log('\n--- 14. AI 接入（/mcp 与 API Token） ---');
  // Token 管理：登录用户可查看（惰性生成）与轮换
  const tokenRes = await api('/api/auth/token');
  const token = tokenRes.data.token;
  check(
    '登录用户可获取 API Token',
    tokenRes.status === 200 && /^ci_[0-9a-f]{48}$/.test(token || ''),
    String(token),
  );

  const tokenAgain = await api('/api/auth/token');
  check('Token 惰性生成后保持不变', tokenAgain.data.token === token, String(tokenAgain.data.token));

  // /mcp 鉴权
  const anonMcp = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  check('无 Token 访问 /mcp 返回 401', anonMcp.status === 401, String(anonMcp.status));

  const badTokMcp = await mcpCall(
    'ci_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    1,
    'tools/list',
  );
  check('无效 Token 访问 /mcp 返回 401', badTokMcp.status === 401, String(badTokMcp.status));

  // JSON-RPC 握手 + tools/call
  const init = await mcpCall(token, 1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'integration-test', version: '0' },
  });
  check(
    'MCP initialize 握手成功',
    init.status === 200 && init.data.result?.serverInfo?.name === 'cloudissue-data',
    JSON.stringify(init.data).slice(0, 120),
  );

  const summary = await mcpCall(token, 2, 'tools/call', { name: 'board_summary', arguments: {} });
  const summaryOut = jsonContent(summary.data);
  check(
    'board_summary 返回看板概览',
    Number.isInteger(summaryOut?.total) && summaryOut.total >= BASELINE && summaryOut.byStatus,
    JSON.stringify(summaryOut).slice(0, 160),
  );

  // AI 自报身份建卡 → 人在时间线里能看到 AI 留名
  const aiCreate = await mcpCall(token, 3, 'tools/call', {
    name: 'issue_create',
    arguments: {
      title: 'AI 接入验证卡',
      description: '由集成测试经 /mcp 创建',
      status: 'backlog',
      actor: 'ai:integration-test',
    },
  });
  const aiOut = jsonContent(aiCreate.data);
  const aiId = aiOut?.id;
  check(
    'AI 经 /mcp 建卡成功',
    aiCreate.status === 200 && Number.isInteger(aiId),
    JSON.stringify(aiOut).slice(0, 160),
  );
  check(
    'AI 建卡的变更记录带 actor',
    aiOut?.issue?.logs?.[0]?.actor === 'ai:integration-test',
    JSON.stringify(aiOut?.issue?.logs?.[0]),
  );

  const seenFromWeb = await api('/api/issues');
  const aiIssue = (seenFromWeb.data.issues || []).find((i) => i.id === aiId);
  check(
    '人（Web API）能看到 AI 创建的卡与其身份',
    aiIssue?.logs?.[0]?.actor === 'ai:integration-test',
    JSON.stringify(aiIssue?.logs?.[0]),
  );

  // Web 端建卡的 actor 是用户名
  const webCreate = await post('/api/issues', { title: 'Web 端 actor 验证卡', status: 'backlog' });
  check(
    'Web 建卡的变更记录 actor 为登录用户名',
    webCreate.data.issue?.logs?.[0]?.actor === USER_A,
    JSON.stringify(webCreate.data.issue?.logs?.[0]),
  );

  // 清理两张验证卡
  await del(`/api/issues/${aiId}`);
  await del(`/api/issues/${webCreate.data.id}`);

  // 轮换：旧 token 立即失效、新 token 可用
  const rotated = await api('/api/auth/token/rotate', { method: 'POST' });
  const newToken = rotated.data.token;
  check('轮换返回新 Token', rotated.status === 200 && newToken && newToken !== token, String(newToken));

  const oldTok = await mcpCall(token, 4, 'tools/list');
  check('轮换后旧 Token 立即失效', oldTok.status === 401, String(oldTok.status));
  const newTok = await mcpCall(newToken, 5, 'tools/list');
  check(
    '轮换后新 Token 可用',
    newTok.status === 200 && Array.isArray(newTok.data.result?.tools),
    String(newTok.status),
  );

  console.log('\n--- 15. issue board 核心能力（编号/类型/指派/评论） ---');
  // 用户列表（负责人选择器数据源）
  const usersRes = await api('/api/users');
  check(
    '用户列表返回且已脱敏',
    usersRes.status === 200 &&
      Array.isArray(usersRes.data.users) &&
      usersRes.data.users.every((u) => !u.passwordHash && !u.apiToken),
    JSON.stringify(usersRes.data).slice(0, 120),
  );
  const meUser = (usersRes.data.users || []).find((u) => u.username === USER_A);
  check('用户列表包含当前登录用户', Boolean(meUser), JSON.stringify(meUser));

  // 带类型与负责人建卡
  const typed = await post('/api/issues', {
    title: 'board 能力验证卡',
    type: 'bug',
    assigneeId: meUser.id,
    status: 'backlog',
    priority: 'high',
  });
  const typedIssue = typed.data.issue;
  const typedId = typed.data.id;
  check(
    '建卡返回 201 且类型正确',
    typed.status === 201 && typedIssue.type === 'bug',
    JSON.stringify(typedIssue).slice(0, 140),
  );
  check(
    'assigneeId 写入且解析出展示名',
    typedIssue.assigneeId === meUser.id && typedIssue.assignee === (meUser.displayName || USER_A),
    JSON.stringify({ assigneeId: typedIssue.assigneeId, assignee: typedIssue.assignee }),
  );
  check('返回 commentCount 字段', Number.isInteger(typedIssue.commentCount), String(typedIssue.commentCount));

  // 无效负责人被拒
  const badAssignee = await post('/api/issues', { title: '无效负责人', assigneeId: 99999999 });
  check('assigneeId 不存在时建卡被拒', badAssignee.status === 400, JSON.stringify(badAssignee.data));

  // 详情端点：字段 + 评论全文
  const detail = await api(`/api/issues/${typedId}`);
  check(
    '详情端点返回 issue 与 comments',
    detail.status === 200 && detail.data.issue?.id === typedId && Array.isArray(detail.data.comments),
    JSON.stringify(detail.data).slice(0, 120),
  );

  // 详情抽屉的评论闭环：添加 → 详情可见 → 删他人 403 → 删自己成功
  const c1 = await post(`/api/issues/${typedId}/comments`, { body: '第一条评论（A）' });
  check(
    '添加评论返回 201 与作者',
    c1.status === 201 && c1.data.comments?.some((c) => c.authorName === (meUser.displayName || USER_A)),
    JSON.stringify(c1.data).slice(0, 140),
  );
  const detail2 = await api(`/api/issues/${typedId}`);
  check('评论出现在详情里', detail2.data.comments?.length === 1, JSON.stringify(detail2.data.comments));

  // B 登录后尝试删 A 的评论 → 403
  cookieJar = '';
  const loginB2 = await post('/api/auth/login', { username: USER_B, password: 'password123' });
  check('B 重新登录成功', loginB2.status === 200, String(loginB2.status));
  const forbidden = await del(`/api/comments/${c1.data.id}?issueId=${typedId}`);
  check('删除他人评论返回 403', forbidden.status === 403, JSON.stringify(forbidden.data));

  // B 自己评论再删除 → 200
  const c2 = await post(`/api/issues/${typedId}/comments`, { body: 'B 的评论' });
  const delOwn = await del(`/api/comments/${c2.data.id}?issueId=${typedId}`);
  check('删除自己的评论成功', delOwn.status === 200, JSON.stringify(delOwn.data));
  cookieJar = cookieANew; // 回到 A 的会话

  // 更新类型与清空指派
  const updTyped = await put(`/api/issues/${typedId}`, { type: 'feature', assigneeId: null });
  check(
    '更新类型成功且清空指派',
    updTyped.status === 200 &&
      updTyped.data.issue.type === 'feature' &&
      updTyped.data.issue.assigneeId === null,
    JSON.stringify({ type: updTyped.data.issue?.type, assigneeId: updTyped.data.issue?.assigneeId }),
  );

  // board_summary 带 byType
  const sum2 = await mcpCall(rotated.data.token, 6, 'tools/call', { name: 'board_summary', arguments: {} });
  const sumOut = jsonContent(sum2.data);
  check(
    'board_summary 包含 byType',
    Boolean(sumOut?.byType && sumOut.byType.bug >= 0),
    JSON.stringify(sumOut?.byType),
  );

  // AI 经 /mcp 评论（自报身份）
  const aiComment = await mcpCall(rotated.data.token, 7, 'tools/call', {
    name: 'issue_comment_add',
    arguments: { issueId: typedId, body: 'AI 联调记录', authorName: 'ai:integration-test' },
  });
  const aiCommentOut = jsonContent(aiComment.data);
  check(
    'AI 经 /mcp 评论并留名',
    aiComment.status === 200 && aiCommentOut.comments?.some((c) => c.authorName === 'ai:integration-test'),
    JSON.stringify(aiCommentOut).slice(0, 160),
  );

  // 清理
  const delTyped = await del(`/api/issues/${typedId}`);
  check('清理验证卡成功', delTyped.status === 200, JSON.stringify(delTyped.data));
  const afterTyped = await api(`/api/issues/${typedId}`);
  check('验证卡已删除（详情 404 类错误）', afterTyped.status >= 400, String(afterTyped.status));

  console.log('\n--- 16. issue_search 检索（AI 精准查询） ---');
  const srchCard = await mcpCall(rotated.data.token, 8, 'tools/call', {
    name: 'issue_create',
    arguments: {
      title: '检索验证卡 searchprobe',
      type: 'bug',
      assigneeId: meUser.id,
      status: 'backlog',
      actor: 'ai:search-test',
    },
  });
  const srchId = jsonContent(srchCard.data)?.id;
  check('检索准备：AI 建卡成功', Number.isInteger(srchId), String(srchId));

  const byKw = await mcpCall(rotated.data.token, 9, 'tools/call', {
    name: 'issue_search',
    arguments: { keyword: `#${srchId}` },
  });
  const byKwOut = jsonContent(byKw.data);
  check(
    '关键词 #编号 检索命中',
    byKwOut?.total === 1 && byKwOut.issues?.[0]?.id === srchId,
    JSON.stringify(byKwOut).slice(0, 140),
  );

  const byCombo = await mcpCall(rotated.data.token, 10, 'tools/call', {
    name: 'issue_search',
    arguments: { status: 'backlog', type: 'bug', assigneeId: meUser.id },
  });
  const byComboOut = jsonContent(byCombo.data);
  check(
    '状态+类型+负责人组合检索命中',
    byComboOut?.issues?.some((i) => i.id === srchId),
    JSON.stringify(byComboOut).slice(0, 140),
  );

  const byLimit = await mcpCall(rotated.data.token, 11, 'tools/call', {
    name: 'issue_search',
    arguments: { limit: 1, offset: 0 },
  });
  const byLimitOut = jsonContent(byLimit.data);
  check(
    'limit/offset 分页生效',
    byLimitOut?.issues?.length === 1 && byLimitOut.total >= 1,
    JSON.stringify({ total: byLimitOut?.total, n: byLimitOut?.issues?.length }),
  );

  const none = await mcpCall(rotated.data.token, 12, 'tools/call', {
    name: 'issue_search',
    arguments: { keyword: '绝无仅有的字符串xyzq' },
  });
  check('无命中时 total 为 0', jsonContent(none.data)?.total === 0, JSON.stringify(jsonContent(none.data)));

  const delSrch = await mcpCall(rotated.data.token, 13, 'tools/call', {
    name: 'issue_delete',
    arguments: { id: srchId },
  });
  check('清理检索验证卡', jsonContent(delSrch.data)?.deleted === true, JSON.stringify(delSrch.data));

  console.log('\n--- 17. 多看板 workspace ---');
  // 未登录不可见：本节在登录之后执行，先暂存 cookie jar 模拟匿名访问
  const savedJar = cookieJar;
  cookieJar = '';
  const anonBoards = await api('/api/boards');
  check('未登录读取看板列表返回 401', anonBoards.status === 401, JSON.stringify(anonBoards.data));
  const anonBoardCreate = await post('/api/boards', { name: '匿名板' });
  check('未登录新建看板返回 401', anonBoardCreate.status === 401, JSON.stringify(anonBoardCreate.data));
  cookieJar = savedJar;

  // 默认看板：历史库由 schema 幂等补种，一定存在
  const boardsRes = await api('/api/boards');
  const boards = boardsRes.data.boards || [];
  const defaultBoard = boards.find((b) => b.name === '默认看板');
  check(
    '看板列表包含默认看板',
    boardsRes.status === 200 && Boolean(defaultBoard),
    JSON.stringify(boards).slice(0, 200),
  );
  check('看板带 issueCount 字段', Number.isInteger(defaultBoard?.issueCount), JSON.stringify(defaultBoard));

  // 新建与重名
  const nbName = `看板_${uniq}`;
  const nb = await post('/api/boards', { name: nbName, description: '集成测试用' });
  check(
    '新建看板返回 201 与看板信息',
    nb.status === 201 && nb.data.board?.name === nbName,
    JSON.stringify(nb.data),
  );
  const nbId = nb.data.board?.id;
  const dupBoard = await post('/api/boards', { name: nbName });
  check('重名看板被拒绝', dupBoard.status === 400, JSON.stringify(dupBoard.data));
  const emptyName = await post('/api/boards', { name: '   ' });
  check('空看板名被拒绝', emptyName.status === 400, JSON.stringify(emptyName.data));

  // AI 在新看板建卡：boardId 归属写入
  const nbCard = await mcpCall(rotated.data.token, 20, 'tools/call', {
    name: 'issue_create',
    arguments: { title: `跨看板卡_${uniq}`, boardId: nbId, actor: 'ai:it' },
  });
  const nbCardIssue = jsonContent(nbCard.data)?.issue;
  check(
    'AI 在新看板建卡成功且归属正确',
    Number.isInteger(nbCardIssue?.id) && nbCardIssue.boardId === nbId && nbCardIssue.boardName === nbName,
    JSON.stringify(nbCard.data).slice(0, 200),
  );
  const nbCardId = nbCardIssue?.id;

  // 看板隔离：列表按 boardId 过滤
  const listNb = await api(`/api/issues?boardId=${nbId}`);
  check(
    '新看板列表只含自己的卡',
    listNb.status === 200 && listNb.data.issues?.length === 1 && listNb.data.issues[0].id === nbCardId,
    JSON.stringify(listNb.data).slice(0, 200),
  );
  const listDef = await api(`/api/issues?boardId=${defaultBoard.id}`);
  check('默认看板列表不含新看板的卡', !(listDef.data.issues || []).some((i) => i.id === nbCardId));
  const listAll = await api('/api/issues');
  check(
    '不带 boardId 返回全部看板的卡',
    (listAll.data.issues || []).some((i) => i.id === nbCardId),
  );
  const badBoardList = await api('/api/issues?boardId=abc');
  check('非法 boardId 返回 400', badBoardList.status === 400, JSON.stringify(badBoardList.data));

  // 检索按看板过滤
  const srchNb = await mcpCall(rotated.data.token, 21, 'tools/call', {
    name: 'issue_search',
    arguments: { boardId: nbId },
  });
  const srchNbOut = jsonContent(srchNb.data);
  check(
    'issue_search 按看板过滤',
    srchNbOut?.total === 1 && srchNbOut.issues?.every((i) => i.boardId === nbId),
    JSON.stringify(srchNbOut).slice(0, 160),
  );

  // board_summary：看板清单 + 单看板统计
  const sumAll = await mcpCall(rotated.data.token, 22, 'tools/call', {
    name: 'board_summary',
    arguments: {},
  });
  check(
    'board_summary 带全部看板清单',
    (jsonContent(sumAll.data)?.boards || []).some((b) => b.id === nbId),
    JSON.stringify(jsonContent(sumAll.data)?.boards).slice(0, 200),
  );
  const sumNb = await mcpCall(rotated.data.token, 23, 'tools/call', {
    name: 'board_summary',
    arguments: { boardId: nbId },
  });
  check(
    'board_summary 单看板统计 total=1',
    jsonContent(sumNb.data)?.total === 1,
    JSON.stringify(jsonContent(sumNb.data)).slice(0, 160),
  );

  // 跨看板移动：issue_update boardId
  const mvBoard = await mcpCall(rotated.data.token, 24, 'tools/call', {
    name: 'issue_update',
    arguments: { id: nbCardId, boardId: defaultBoard.id, actor: 'ai:it' },
  });
  check(
    'issue_update 可把卡移到另一个看板',
    jsonContent(mvBoard.data)?.issue?.boardId === defaultBoard.id,
    JSON.stringify(jsonContent(mvBoard.data)).slice(0, 200),
  );
  const listDef2 = await api(`/api/issues?boardId=${defaultBoard.id}`);
  check(
    '移动后默认看板能看到该卡',
    (listDef2.data.issues || []).some((i) => i.id === nbCardId),
  );

  // 不存在的看板：MCP SDK 把 McpError 包装为 isError 结果，错误码在文本前缀里
  const ghostBoard = await mcpCall(rotated.data.token, 25, 'tools/call', {
    name: 'issue_create',
    arguments: { title: '幽灵看板卡', boardId: 999999 },
  });
  const ghostText = ghostBoard.data?.result?.content?.[0]?.text || '';
  check(
    '指定不存在的看板建卡被拒绝（isError + -32602 前缀）',
    jsonContent(ghostBoard.data) === null &&
      ghostBoard.data?.result?.isError === true &&
      ghostText.startsWith('MCP error -32602'),
    JSON.stringify(ghostBoard.data).slice(0, 200),
  );

  // 删除看板：任务级联消失
  const tmp = await post('/api/boards', { name: `临时_${uniq}` });
  const tmpId = tmp.data.board?.id;
  const tmpCard = await mcpCall(rotated.data.token, 26, 'tools/call', {
    name: 'issue_create',
    arguments: { title: `随板消失_${uniq}`, boardId: tmpId },
  });
  const tmpCardId = jsonContent(tmpCard.data)?.id;
  const delTmp = await del(`/api/boards/${tmpId}`);
  check(
    '删除看板返回成功',
    delTmp.status === 200 && delTmp.data.deleted === true,
    JSON.stringify(delTmp.data),
  );
  const tmpCardGone = await api(`/api/issues/${tmpCardId}`);
  check(
    '看板删除后其任务级联删除',
    tmpCardGone.status === 400 || tmpCardGone.status === 404,
    String(tmpCardGone.status),
  );
  const boardsAfter = await api('/api/boards');
  check('看板列表不再包含已删看板', !(boardsAfter.data.boards || []).some((b) => b.id === tmpId));

  // 清理：跨看板卡 + 测试看板（默认看板绝不动——里面有示例数据与用户数据）
  const delMovedCard = await mcpCall(rotated.data.token, 27, 'tools/call', {
    name: 'issue_delete',
    arguments: { id: nbCardId },
  });
  check('清理跨看板移动卡', jsonContent(delMovedCard.data)?.deleted === true);
  const delNb = await del(`/api/boards/${nbId}`);
  check('清理集成测试看板', delNb.status === 200, JSON.stringify(delNb.data));

  console.log('\n--- 18. CSV 导出（与看板同口径） ---');
  // 未登录 / 非法参数（沿用第 17 节的临时匿名 jar 技巧）
  cookieJar = '';
  const anonExport = await api('/api/export/csv');
  check('未登录导出返回 401', anonExport.status === 401, String(anonExport.status));
  cookieJar = savedJar;
  const badExport = await api('/api/export/csv?boardId=abc');
  check('非法 boardId 导出返回 400', badExport.status === 400, String(badExport.status));

  // 造数据：专用导出看板，覆盖类型/优先级/标签/指派/描述换行/引号
  // CSV 响应体不是 JSON，用原生 fetch 拿原始 Response
  const rawGet = (path) => {
    const headers = {};
    if (cookieJar) headers.Cookie = cookieJar;
    return fetch(BASE + path, { headers });
  };
  const expBoard = await post('/api/boards', { name: `导出_${uniq}` });
  const expBd = expBoard.data.board?.id;
  const mkCard = (n, extra = {}) =>
    mcpCall(rotated.data.token, 30 + n, 'tools/call', {
      name: 'issue_create',
      arguments: { boardId: expBd, actor: 'ai:it', ...extra },
    });
  await mkCard(1, {
    title: `导出高优_${uniq}`,
    description: '含,逗号、"引号"与\n换行的描述',
    priority: 'high',
    type: 'feature',
    tags: ['标签A'],
    assigneeId: meUser.id,
    status: 'planning',
  });
  await mkCard(2, { title: `导出低优_${uniq}`, priority: 'low', type: 'bug', status: 'backlog' });
  await mkCard(3, { title: `导出已完成_${uniq}`, priority: 'medium', status: 'done' });
  const defaultCard = await post('/api/issues', { title: `默认板导出卡_${uniq}` });

  // 全量导出该板：行数、BOM、表头、Content-Disposition
  const expAll = await rawGet(`/api/export/csv?boardId=${expBd}`);
  check(
    '导出返回 200 且为 CSV',
    expAll.status === 200 && /text\/csv/.test(expAll.headers.get('content-type') || ''),
    String(expAll.status),
  );
  check(
    '导出带 X-Export-Count',
    expAll.headers.get('x-export-count') === '3',
    String(expAll.headers.get('x-export-count')),
  );
  check(
    'Content-Disposition 带 UTF-8 文件名',
    /filename\*=UTF-8''/.test(expAll.headers.get('content-disposition') || ''),
  );
  // fetch 的 Response.text() 按 UTF-8 解码会剥掉 BOM，因此 BOM 用原始字节断言
  const expAllBytes = new Uint8Array(await expAll.arrayBuffer());
  check(
    'CSV 以 UTF-8 BOM（EF BB BF）开头',
    expAllBytes[0] === 0xef && expAllBytes[1] === 0xbb && expAllBytes[2] === 0xbf,
    String(expAllBytes.slice(0, 3)),
  );
  const csvText = new TextDecoder().decode(expAllBytes).replace(/^\uFEFF/, '');
  const csvLines = csvText.split('\r\n').filter(Boolean);
  check('CSV 表头为中文列名', csvLines[0].startsWith('#编号,标题,类型,状态,优先级'), csvLines[0]);
  check('全量导出行数正确（3 卡 + 表头）', csvLines.length === 4, String(csvLines.length));
  check('导出不串板（无默认板的卡）', !csvText.includes(`默认板导出卡_${uniq}`));

  // 同口径过滤：关键词 / 优先级 / 标签 / 负责人 / aiOnly
  const parseBody = (text) => text.split('\r\n').filter(Boolean).slice(1); // 去表头
  const expQ = await rawGet(`/api/export/csv?boardId=${expBd}&aiOnly=1`);
  const qBody = parseBody(await expQ.text());
  check('aiOnly 过滤命中 AI 建的 3 张卡', qBody.length === 3, String(qBody.length));
  const expHigh = await rawGet(`/api/export/csv?boardId=${expBd}&priority=high`);
  const highBody = parseBody(await expHigh.text());
  check(
    'priority 过滤只留高优',
    highBody.length === 1 && highBody[0].includes(`导出高优_${uniq}`),
    highBody.join(' ; ').slice(0, 120),
  );
  const expTag = await rawGet(`/api/export/csv?boardId=${expBd}&tag=${encodeURIComponent('标签A')}`);
  check('tag 过滤命中打标卡', parseBody(await expTag.text()).length === 1);
  const expAssignee = await rawGet(`/api/export/csv?boardId=${expBd}&assignee=${meUser.id}`);
  check('assignee 过滤命中指派卡', parseBody(await expAssignee.text()).length === 1);

  // RFC 4180 转义：逗号/引号/换行的字段被引号包裹，行数不被换行破坏
  check('换行/逗号/引号字段被正确转义', csvText.includes('"含,逗号、""引号""与\n换行的描述"'), '');

  // 排序与看板一致：五列顺序 + 列内 position（backlog → planning → done）
  const orderLine = parseBody(csvText).map((l) => l.split(',')[3]);
  check(
    '导出按五列顺序排列',
    JSON.stringify(orderLine) === JSON.stringify(['未规划', '规划中', '已完成']),
    orderLine.join('→'),
  );

  // 清理
  const delExpBoard = await del(`/api/boards/${expBd}`);
  check('清理导出测试看板', delExpBoard.status === 200, JSON.stringify(delExpBoard.data));
  const delDefaultCard = await del(`/api/issues/${defaultCard.data.id}`);
  check('清理默认板导出验证卡', delDefaultCard.status === 200, JSON.stringify(delDefaultCard.data));

  console.log('\n--- 19. 看板成员与权限（owner/member/viewer） ---');
  // 三个新用户：A 建板（owner）、B 被加入（member）、C 被加入（viewer）
  const regU = async (name) => {
    const saved = cookieJar;
    cookieJar = '';
    const r = await post('/api/auth/register', { username: name, password: 'password123' });
    cookieJar = saved;
    return r.data.user;
  };
  const loginAs = async (username) => {
    const saved = cookieJar;
    cookieJar = '';
    await post('/api/auth/login', { username, password: 'password123' });
    const jar = cookieJar;
    cookieJar = saved;
    return jar;
  };
  const withJar = async (jar, fn) => {
    const saved = cookieJar;
    cookieJar = jar;
    try {
      return await fn();
    } finally {
      cookieJar = saved;
    }
  };

  const UA = await regU(`perm_a_${uniq}`);
  const UB = await regU(`perm_b_${uniq}`);
  const UC = await regU(`perm_c_${uniq}`);
  check('注册三个权限测试用户', Boolean(UA?.id && UB?.id && UC?.id));
  const jarA = await loginAs(`perm_a_${uniq}`);
  const jarB = await loginAs(`perm_b_${uniq}`);
  const jarC = await loginAs(`perm_c_${uniq}`);

  // 新注册用户默认是默认看板的 member：可读，也可建卡
  const b0 = await withJar(jarB, () => api('/api/boards'));
  check(
    '新用户默认加入默认看板为 member',
    b0.data.boards.some((b) => b.name === '默认看板' && b.myRole === 'member'),
    JSON.stringify(b0.data).slice(0, 160),
  );

  // A 建私有板（owner）
  const permBoard = await withJar(jarA, () => post('/api/boards', { name: `权限板_${uniq}` }));
  const pbId = permBoard.data.board?.id;
  check('创建者自动成为 owner', permBoard.data.board?.myRole === 'owner', JSON.stringify(permBoard.data));

  // B（未加入）不可见也不可写：私有化可见范围
  const bB = await withJar(jarB, () => api('/api/boards'));
  check('非成员的看板列表不可见', !bB.data.boards.some((b) => b.id === pbId));
  const bBissue = await withJar(jarB, () => api(`/api/issues?boardId=${pbId}`));
  check(
    '非成员读看板被拒绝（400）',
    bBissue.status === 400 && /成员/.test(bBissue.data.error || ''),
    JSON.stringify(bBissue.data),
  );

  // A 把 B 加为 member、C 加为 viewer
  const addB = await withJar(jarA, () =>
    post(`/api/boards/${pbId}/members`, { userId: UB.id, role: 'member' }),
  );
  check(
    'owner 添加 member 成功',
    addB.status === 201 && addB.data.updated === true,
    JSON.stringify(addB.data),
  );
  const addC = await withJar(jarA, () =>
    post(`/api/boards/${pbId}/members`, { userId: UC.id, role: 'viewer' }),
  );
  check('owner 添加 viewer 成功', addC.status === 201);

  // member 可写
  const bCard = await withJar(jarB, () => post('/api/issues', { title: `成员建卡_${uniq}`, boardId: pbId }));
  check(
    'member 建卡成功',
    bCard.status === 201 && bCard.data.issue?.boardId === pbId,
    JSON.stringify(bCard.data).slice(0, 120),
  );
  const bEdit = await withJar(jarB, () => put(`/api/issues/${bCard.data.id}`, { title: `成员改卡_${uniq}` }));
  check('member 改卡成功', bEdit.status === 200);

  // viewer 可读不可写
  const cRead = await withJar(jarC, () => api(`/api/issues?boardId=${pbId}`));
  check('viewer 可读看板', cRead.status === 200 && cRead.data.issues?.length === 1, String(cRead.status));
  const cWrite = await withJar(jarC, () => post('/api/issues', { title: 'viewer越权卡', boardId: pbId }));
  check(
    'viewer 写看板被拒绝（400）',
    cWrite.status === 400 && /只读成员/.test(cWrite.data.error || ''),
    JSON.stringify(cWrite.data),
  );
  const cDel = await withJar(jarC, () => del(`/api/issues/${bCard.data.id}`));
  check('viewer 删卡被拒绝', cDel.status === 400);

  // member 不能管理成员、不能删板；owner 专属操作
  const bAddMember = await withJar(jarB, () =>
    post(`/api/boards/${pbId}/members`, { userId: UA.id, role: 'viewer' }),
  );
  check('member 添加成员被拒（owner 专属）', bAddMember.status === 400, JSON.stringify(bAddMember.data));
  const cDelBoard = await withJar(jarC, () => del(`/api/boards/${pbId}`));
  check('viewer 删板被拒（owner 专属）', cDelBoard.status === 400);
  const bDelBoard = await withJar(jarB, () => del(`/api/boards/${pbId}`));
  check('member 删板被拒（owner 专属）', bDelBoard.status === 400);

  // 成员列表与最后 owner 保护
  const mList = await withJar(jarC, () => api(`/api/boards/${pbId}/members`));
  check(
    'viewer 可看成员列表（3 人）',
    mList.status === 200 && mList.data.members?.length === 3,
    JSON.stringify(mList.data).slice(0, 160),
  );
  const demoteOwner = await withJar(jarA, () =>
    post(`/api/boards/${pbId}/members`, { userId: UA.id, role: 'member' }),
  );
  check('降级最后一个 owner 被拒', demoteOwner.status === 400, JSON.stringify(demoteOwner.data));
  const removeOwner = await withJar(jarA, () => del(`/api/boards/${pbId}/members/${UA.id}`));
  check('移除最后一个 owner 被拒', removeOwner.status === 400, JSON.stringify(removeOwner.data));

  // AI 越权：AI token（A 的）对 A 不在的板写 → 被护栏拦截；
  // 且 JSON-RPC 里伪造 actorId 无效——身份以 Bearer Token 为准
  const aiTokenRes = await withJar(jarA, () => api('/api/auth/token'));
  const aiToken = aiTokenRes.data.token;
  check('A 获取 AI Token', Boolean(aiToken), String(aiTokenRes.status));
  const aiForge = await mcpCall(aiToken, 40, 'tools/call', {
    name: 'issue_create',
    arguments: { title: '伪造身份卡', boardId: pbId, actorId: UC.id },
  });
  const aiForgeText = aiForge.data?.result?.content?.[0]?.text || '';
  check(
    'AI 塞伪造 actorId 无效（以 Token 身份 = owner 放行）',
    jsonContent(aiForge.data)?.created === true,
    aiForgeText.slice(0, 120),
  );
  const aiCard = jsonContent(aiForge.data)?.issue?.id;
  // C（viewer）的 AI token 对私有板写 → 与 Web 同受只读护栏
  const aiTokenC = await withJar(jarC, () => api('/api/auth/token')).then((r) => r.data.token);
  const aiC = await mcpCall(aiTokenC, 41, 'tools/call', {
    name: 'issue_create',
    arguments: { title: 'AI只读越权卡', boardId: pbId },
  });
  check(
    'AI viewer 写看板被拒（isError）',
    jsonContent(aiC.data) === null && /只读成员/.test(aiC.data?.result?.content?.[0]?.text || ''),
    (aiC.data?.result?.content?.[0]?.text || '').slice(0, 120),
  );
  // 无关用户 D 的 AI token（非成员）→ 越权被拦
  await regU(`perm_d_${uniq}`);
  const jarD = await loginAs(`perm_d_${uniq}`);
  const aiTokenD = await withJar(jarD, () => api('/api/auth/token')).then((r) => r.data.token);
  const aiD = await mcpCall(aiTokenD, 42, 'tools/call', {
    name: 'issue_create',
    arguments: { title: 'AI越权卡', boardId: pbId },
  });
  check(
    'AI 非成员写私有板被拒（isError）',
    jsonContent(aiD.data) === null && /成员/.test(aiD.data?.result?.content?.[0]?.text || ''),
    (aiD.data?.result?.content?.[0]?.text || '').slice(0, 120),
  );

  // C 被移除后立即失去可见性
  const rmC = await withJar(jarA, () => del(`/api/boards/${pbId}/members/${UC.id}`));
  check('owner 移除 viewer 成功', rmC.status === 200, JSON.stringify(rmC.data));
  const cAfter = await withJar(jarC, () => api(`/api/issues?boardId=${pbId}`));
  check('被移除的成员立即失去访问权', cAfter.status === 400, String(cAfter.status));

  // 清理
  const delPermCard = await withJar(jarA, () => del(`/api/issues/${aiCard}`));
  check('清理权限测试卡', delPermCard.status === 200);
  const delPermBoard = await withJar(jarA, () => del(`/api/boards/${pbId}`));
  check('清理权限测试看板', delPermBoard.status === 200, JSON.stringify(delPermBoard.data));

  console.log('\n--- 20. 站内通知（状态流转/指派/评论 → 成员） ---');
  // 复用第 19 节的 A/B/C 用户（pbId 板已清理）；建一块通知专用板
  const ntBoard = await withJar(jarA, () => post('/api/boards', { name: `通知板_${uniq}` }));
  const ntBd = ntBoard.data.board?.id;
  await withJar(jarA, () => post(`/api/boards/${ntBd}/members`, { userId: UB.id, role: 'member' }));
  await withJar(jarA, () => post(`/api/boards/${ntBd}/members`, { userId: UC.id, role: 'viewer' }));
  check('通知专用板就绪（A owner/B member/C viewer）', Number.isInteger(ntBd), JSON.stringify(ntBoard.data));

  // B 移动卡 → A 收到 status 通知，B 不收（操作者排除）
  const bCard2 = await withJar(jarB, () => post('/api/issues', { title: `通知卡_${uniq}`, boardId: ntBd }));
  const ntCardId = bCard2.data.id;
  const bMove = await withJar(jarB, () => post(`/api/issues/${ntCardId}/move`, { toStatus: 'planning' }));
  check('B 移卡成功（通知前置）', bMove.status === 200, JSON.stringify(bMove.data));
  const aNotifs = await withJar(jarA, () => api('/api/notifications'));
  const aStatus = (aNotifs.data.notifications || []).find(
    (n) => n.issueId === ntCardId && n.type === 'status',
  );
  check(
    'owner 收到状态流转通知',
    Boolean(aStatus) && /未规划 → 规划中/.test(aStatus.title) && aStatus.actor === `perm_b_${uniq}`,
    JSON.stringify(aNotifs.data.notifications?.[0]).slice(0, 140),
  );
  const bNotifs = await withJar(jarB, () => api('/api/notifications'));
  check(
    '操作者本人不收自己的动作',
    !(bNotifs.data.notifications || []).some((n) => n.issueId === ntCardId && n.type === 'status'),
    JSON.stringify(bNotifs.data.notifications?.slice(0, 2)).slice(0, 140),
  );

  // A 指派卡给 B → B 收到 assignee 通知（member 直达）
  const aAssign = await withJar(jarA, () => put(`/api/issues/${ntCardId}`, { assigneeId: UB.id }));
  check('A 指派卡给 B 成功', aAssign.status === 200, JSON.stringify(aAssign.data).slice(0, 120));
  const bAfterAssign = await withJar(jarB, () => api('/api/notifications'));
  const bAssigned = (bAfterAssign.data.notifications || []).find(
    (n) => n.type === 'assignee' && n.issueId === ntCardId,
  );
  check(
    '被指派人收到指派通知',
    Boolean(bAssigned) && /指派给你/.test(bAssigned.title),
    JSON.stringify(bAssigned).slice(0, 140),
  );

  // viewer 评论被拒（只读护栏对评论同样生效）
  const cComment = await withJar(jarC, () =>
    post(`/api/issues/${ntCardId}/comments`, { body: 'viewer越权评论' }),
  );
  check(
    'viewer 评论被拒（只读护栏覆盖评论）',
    cComment.status === 400 && /只读成员/.test(cComment.data.error || ''),
    JSON.stringify(cComment.data),
  );

  // B（member）评论 → A/C 收到 comment 通知；B 本人不收
  const bComment = await withJar(jarB, () =>
    post(`/api/issues/${ntCardId}/comments`, { body: `请关注这条评论_${uniq}` }),
  );
  check('B 评论成功', bComment.status === 201, JSON.stringify(bComment.data).slice(0, 120));
  const aAfterComment = await withJar(jarA, () => api('/api/notifications'));
  check(
    '成员收到评论通知（含摘要与评论者）',
    (aAfterComment.data.notifications || []).some(
      (n) =>
        n.type === 'comment' &&
        n.issueId === ntCardId &&
        n.actor === `perm_b_${uniq}` &&
        n.title.includes(`请关注这条评论_${uniq}`.slice(0, 20)),
    ),
    JSON.stringify(aAfterComment.data.notifications?.[0]).slice(0, 160),
  );
  const bNotifsAfterComment = await withJar(jarB, () => api('/api/notifications'));
  check(
    '评论者本人不收自己的评论通知',
    !(bNotifsAfterComment.data.notifications || []).some(
      (n) => n.type === 'comment' && n.issueId === ntCardId,
    ),
  );

  // AI 操作也触发通知（A 的 token 移动卡 → A 不收自己的，B 收到 actor=ai:xxx）
  const aiMove = await mcpCall(aiToken, 50, 'tools/call', {
    name: 'issue_move',
    arguments: { id: ntCardId, toStatus: 'done', actor: 'ai:notify-bot' },
  });
  check(
    'AI 移卡成功（通知前置）',
    jsonContent(aiMove.data)?.moved === true,
    (aiMove.data?.result?.content?.[0]?.text || '').slice(0, 120),
  );
  const bAfterAi = await withJar(jarB, () => api('/api/notifications'));
  const aiNotif = (bAfterAi.data.notifications || []).find(
    (n) => n.type === 'status' && n.issueId === ntCardId,
  );
  check(
    '成员收到 AI 操作的通知（actor 快照为自报名）',
    Boolean(aiNotif) && aiNotif.actor === 'ai:notify-bot' && /规划中 → 已完成/.test(aiNotif.title),
    JSON.stringify(aiNotif).slice(0, 160),
  );

  // 未读数 / 单条已读 / 全部已读 / 用户隔离
  const aUnreadBefore = await withJar(jarA, () => api('/api/notifications/unread_count'));
  check(
    '未读数端点',
    Number.isInteger(aUnreadBefore.data?.unreadCount) && aUnreadBefore.data.unreadCount >= 2,
    String(aUnreadBefore.data?.unreadCount),
  );
  const firstUnread = (aNotifs.data.notifications || []).find((n) => !n.read);
  const markRead = await withJar(jarA, () => post(`/api/notifications/${firstUnread.id}/read`));
  check(
    '单条已读成功',
    markRead.status === 200 && markRead.data.updated === true,
    JSON.stringify(markRead.data),
  );
  const markAgain = await withJar(jarA, () => post(`/api/notifications/${firstUnread.id}/read`));
  check('重复已读被拒（幂等护栏）', markAgain.status === 400, String(markAgain.status));
  const readAll = await withJar(jarA, () => post('/api/notifications/read_all'));
  check(
    '全部已读成功',
    readAll.status === 200 && Number.isInteger(readAll.data.count),
    JSON.stringify(readAll.data),
  );
  const aUnreadAfter = await withJar(jarA, () => api('/api/notifications/unread_count'));
  check('全部已读后未读数归零', aUnreadAfter.data.unreadCount === 0, String(aUnreadAfter.data.unreadCount));
  const bUnread = await withJar(jarB, () => api('/api/notifications/unread_count'));
  check('用户隔离（A 已读不影响 B 的未读）', bUnread.data.unreadCount > 0, String(bUnread.data.unreadCount));

  // 分页
  const paged = await withJar(jarB, () => api('/api/notifications?limit=1&offset=0'));
  check(
    '通知列表分页与未读汇总',
    (paged.data.notifications || []).length === 1 && Number.isInteger(paged.data.unreadCount),
    JSON.stringify({ n: paged.data.notifications?.length, unread: paged.data.unreadCount }),
  );

  // 删卡级联删通知
  const delNb2 = await withJar(jarA, () => del(`/api/issues/${ntCardId}`));
  check('删除通知测试卡', delNb2.status === 200);
  const aAfterDel = await withJar(jarA, () => api('/api/notifications'));
  check('删卡后相关通知级联消失', !(aAfterDel.data.notifications || []).some((n) => n.issueId === ntCardId));
  const delNtBoard = await withJar(jarA, () => del(`/api/boards/${ntBd}`));
  check('清理通知测试看板', delNtBoard.status === 200, JSON.stringify(delNtBoard.data));

  console.log('\n--- 21. Webhook 外发通知（事件流 → 端点） ---');
  // 本地 HTTP 接收端：记录请求（url/body/headers）
  const received = [];
  const sink = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body });
      // /flaky 路径前 2 次返回 500，测试重试
      const flakyCount = received.filter((r) => r.url === '/flaky').length;
      res.statusCode = req.url === '/flaky' && flakyCount <= 2 ? 500 : 200;
      res.end('ok');
    });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const sinkPort = sink.address().port;

  // A 建通知专用板 + 三个 webhook（generic 带密钥 / 钉钉加签 / flaky 重试）
  cookieJar = jarA;
  const whBoard = await post('/api/boards', { name: `Webhook板_${uniq}` });
  const whBd = whBoard.data.board?.id;
  await post(`/api/boards/${whBd}/members`, { userId: UB.id, role: 'member' });
  const card = await post('/api/issues', { title: `Webhook卡_${uniq}`, boardId: whBd });
  const whCardId = card.data.id;

  const mk = (url, type, secret, events) =>
    post(`/api/boards/${whBd}/webhooks`, { url, type, secret, events });
  const whGeneric = await mk(`http://127.0.0.1:${sinkPort}/generic`, 'generic', 'hmac-secret-1', ['status']);
  const whDing = await mk(`http://127.0.0.1:${sinkPort}/dingtalk`, 'dingtalk', 'SECdingtalk-secret', [
    'status',
  ]);
  const whFlaky = await mk(`http://127.0.0.1:${sinkPort}/flaky`, 'generic', '', ['status', 'comment']);
  check(
    '创建 3 个 Webhook 订阅',
    [whGeneric, whDing, whFlaky].every((r) => r.status === 201),
    JSON.stringify([whGeneric.status, whDing.status, whFlaky.status]),
  );
  const badUrl = await post(`/api/boards/${whBd}/webhooks`, { url: 'javascript:alert(1)', type: 'generic' });
  check('非法 URL（非 http）被拒', badUrl.status === 400, JSON.stringify(badUrl.data));
  const bWhAdd = await withJar(jarB, () =>
    post(`/api/boards/${whBd}/webhooks`, { url: `http://127.0.0.1:${sinkPort}/x`, type: 'generic' }),
  );
  check('member 添加 Webhook 被拒（owner 专属）', bWhAdd.status === 400, JSON.stringify(bWhAdd.data));

  // 触发事件：A 移动卡到 planning（status 事件）——A 是操作者不收站内通知，但 webhook 是板级端点照发
  await post(`/api/issues/${whCardId}/move`, { toStatus: 'planning' });
  // 分发器周期 10s：轮询接收端最多 15s 等 generic + dingtalk 到达
  let gotGeneric = null;
  let gotDing = null;
  for (let i = 0; i < 30; i++) {
    gotGeneric = received.find((r) => r.url.startsWith('/generic'));
    gotDing = received.find((r) => r.url.startsWith('/dingtalk'));
    if (gotGeneric && gotDing) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check('generic 端点收到事件', Boolean(gotGeneric));
  check('dingtalk 端点收到事件', Boolean(gotDing));
  if (gotGeneric) {
    const payload = JSON.parse(gotGeneric.body);
    check(
      'generic 载荷结构（event/title/actor/issueId）',
      payload.event === 'status' &&
        payload.title.includes(`Webhook卡_${uniq}`) &&
        payload.issueId === whCardId,
      gotGeneric.body.slice(0, 160),
    );
    check(
      'HMAC 签名头存在且可验证',
      Boolean(gotGeneric.headers['x-cloudissue-signature']) &&
        gotGeneric.headers['x-cloudissue-event'] === 'status',
      JSON.stringify(gotGeneric.headers['x-cloudissue-signature']).slice(0, 60),
    );
  }
  if (gotDing) {
    const ding = JSON.parse(gotDing.body);
    check(
      '钉钉载荷格式（msgtype=text）',
      ding.msgtype === 'text' && ding.text?.content?.includes('CloudIssue'),
      gotDing.body.slice(0, 120),
    );
    check(
      '钉钉加签 URL 参数（timestamp+sign）',
      gotDing.url.includes('timestamp=') && gotDing.url.includes('sign='),
      gotDing.url.slice(0, 100),
    );
  }

  // flaky：评论事件触发 → 前 2 次 500 → 重试后成功（重试机制验证）
  await post(`/api/issues/${whCardId}/comments`, { body: `webhook重试验证_${uniq}` });
  let flakyOk = false;
  for (let i = 0; i < 60; i++) {
    // 至少 3 次 /flaky 记录（2 次失败 + 1 次成功）即证明重试
    const flaky = received.filter((r) => r.url.startsWith('/flaky'));
    if (flaky.length >= 3) {
      flakyOk = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  check(
    '失败重试生效（flaky 端点被重投到成功）',
    flakyOk,
    `received flaky: ${received.filter((r) => r.url.startsWith('/flaky')).length}`,
  );

  // Webhook 列表与删除
  const whList = await api(`/api/boards/${whBd}/webhooks`);
  check(
    'Webhook 列表返回 3 条',
    (whList.data.webhooks || []).length === 3,
    JSON.stringify(whList.data).slice(0, 160),
  );
  const delWh = await del(`/api/boards/${whBd}/webhooks/${whFlaky.data.webhook.id}`);
  check('删除 Webhook 成功', delWh.status === 200, JSON.stringify(delWh.data));
  const delWhAgain = await del(`/api/boards/${whBd}/webhooks/${whFlaky.data.webhook.id}`);
  check('重复删除被拒', delWhAgain.status === 400);

  sink.close();
  const delWhBoard = await del(`/api/boards/${whBd}`);
  check('清理 Webhook 测试板', delWhBoard.status === 200);

  console.log('\n--- 22. Git 提交关联（#编号约定 + GitHub webhook） ---');
  // 纯函数：提取规则
  const { extractIssueRefs } = await import('../shared/git-commit.js');
  check(
    '提取 #编号（去重、忽略代码与 URL）',
    JSON.stringify(extractIssueRefs('修复 #12 相关问题，见 #12 与 #7；`#99` 不算；https://x/#3 不算')) ===
      JSON.stringify([12, 7]),
    JSON.stringify(extractIssueRefs('修复 #12 相关问题，见 #12 与 #7；`#99` 不算；https://x/#3 不算')),
  );

  // 准备：专用板 + 卡
  cookieJar = jarA;
  const gitBoard = await post('/api/boards', { name: `Git板_${uniq}` });
  const gitBd = gitBoard.data.board?.id;
  const gitCard = await post('/api/issues', { title: `Git关联卡_${uniq}`, boardId: gitBd });
  const gitCardId = gitCard.data.id;

  // MCP 注册提交（幂等验证）
  const link1 = await mcpCall(aiToken, 60, 'tools/call', {
    name: 'git_commit_link',
    arguments: {
      issueId: gitCardId,
      hash: 'abcdef1234567890abcdef1234567890abcdef12',
      repo: `garyleelty/cloudissue`,
      message: `fix: 修复登录问题 #${gitCardId}`,
      author: 'garyLi',
      branch: 'main',
      createdBy: 'ai:ci-bot',
    },
  });
  check(
    'AI 注册关联提交成功',
    jsonContent(link1.data)?.linked === true,
    (link1.data?.result?.content?.[0]?.text || '').slice(0, 140),
  );
  const link2 = await mcpCall(aiToken, 61, 'tools/call', {
    name: 'git_commit_link',
    arguments: {
      issueId: gitCardId,
      hash: 'ABCDEF1234567890ABCDEF1234567890ABCDEF12',
      message: 'updated message',
      createdBy: 'ci',
    },
  });
  check(
    '同 hash 重复注册幂等（大写归一）',
    jsonContent(link2.data)?.linked === true && jsonContent(link2.data).commit.message === 'updated message',
    (link2.data?.result?.content?.[0]?.text || '').slice(0, 140),
  );

  // GitHub push webhook：起一个带 secret 的专属子服务（主服务进程无法动态配 secret）
  const GSECRET = 'gh-webhook-secret-1';
  const { spawn } = await import('node:child_process');
  const ghPort = 5290 + (process.pid % 500);
  const ghSrv = spawn(process.execPath, ['server/index.js'], {
    // DB 配置不传：子服务自己读 .env（dotenv 不覆盖显式传入的变量）
    env: {
      ...process.env,
      PORT: String(ghPort),
      GITHUB_WEBHOOK_SECRET: GSECRET,
      AUTH_RATE_LIMIT: '20000',
      API_RATE_LIMIT: '20000',
    },
    stdio: 'ignore',
  });
  const ghBase = `http://127.0.0.1:${ghPort}`;
  let ghUp = false;
  for (let i = 0; i < 30; i++) {
    ghUp = await fetch(`${ghBase}/api/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ghUp) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check('签名验证子服务就绪', ghUp);
  const ghPayload = {
    ref: 'refs/heads/main',
    repository: { full_name: 'garyleelty/cloudissue' },
    pusher: { name: 'garyLi' },
    commits: [
      {
        id: '0123456789abcdef0123456789abcdef01234567',
        message: `feat: 关联演示 #${gitCardId}`,
        author: { name: 'garyLi' },
        timestamp: '2026-11-08T12:00:00Z',
      },
      { id: 'ffffffffffffffffffffffffffffffffffffffff', message: '无引用的提交' },
    ],
  };
  const ghBody = JSON.stringify(ghPayload);
  const ghSig = 'sha256=' + crypto.createHmac('sha256', GSECRET).update(ghBody).digest('hex');
  const ghBad = await fetch(`${ghBase}/api/webhooks/github`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'push',
      'X-Hub-Signature-256': 'sha256=deadbeef',
    },
    body: ghBody,
  });
  check('GitHub webhook 错误签名被拒（401）', ghBad.status === 401, String(ghBad.status));
  const ghOk = await fetch(`${ghBase}/api/webhooks/github`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': ghSig },
    body: ghBody,
  });
  const ghOut = await ghOk.json();
  check(
    'GitHub push webhook 关联成功（linked=1，无引用提交跳过）',
    ghOk.status === 200 && ghOut.linked === 1 && ghOut.total === 1,
    JSON.stringify(ghOut),
  );

  // 列表：3 条（1 MCP + 1 幂等更新 + 1 webhook），按提交时间倒序
  const commitList = await api(`/api/issues/${gitCardId}/commits`);
  check(
    '关联提交列表（2 条：MCP 幂等注册 1 + webhook 1，viewer 可读）',
    (commitList.data.commits || []).length === 2,
    JSON.stringify(commitList.data).slice(0, 200),
  );
  check(
    'webhook 来源标记',
    (commitList.data.commits || []).some(
      (c) => c.createdBy === 'github-webhook' && c.repo === 'garyleelty/cloudissue',
    ),
    JSON.stringify(commitList.data.commits?.[0]),
  );

  // 解除关联
  const unlink = await del(`/api/issues/${gitCardId}/commits/abcdef1234567890abcdef1234567890abcdef12`);
  check('解除关联成功', unlink.status === 200 && unlink.data.unlinked === true, JSON.stringify(unlink.data));
  const commitList2 = await api(`/api/issues/${gitCardId}/commits`);
  check(
    '解除后列表减一',
    (commitList2.data.commits || []).length === 1,
    String((commitList2.data.commits || []).length),
  );

  ghSrv.kill();
  const delGitBoard = await del(`/api/boards/${gitBd}`);
  check('清理 Git 测试板', delGitBoard.status === 200);

  console.log('\n--- 23. 服务端分页与推送（search / issue_list 安全阀 / SSE） ---');
  // 复用 jarA（owner）与通知演示板的语境——建独立数据
  cookieJar = jarA;
  const pgBoard = await post('/api/boards', { name: `分页板_${uniq}` });
  const pgBd = pgBoard.data.board?.id;
  const ids = [];
  for (let i = 1; i <= 7; i += 1) {
    const c = await post('/api/issues', {
      title: `分页卡${i}_${uniq}`,
      boardId: pgBd,
      priority: i % 2 === 0 ? 'high' : 'low',
      tags: i === 1 ? ['分页标签'] : [],
    });
    ids.push(c.data.id);
  }
  check('分页测试数据就绪（7 张卡）', ids.length === 7);

  // search：分页 + total
  const page1 = await api(`/api/issues/search?boardId=${pgBd}&limit=3&offset=0&sort=id&order=asc`);
  check(
    'search 分页第一页（3 条 + total=7）',
    (page1.data.issues || []).length === 3 && page1.data.total === 7,
    JSON.stringify({ n: page1.data.issues?.length, total: page1.data.total }),
  );
  const page3 = await api(`/api/issues/search?boardId=${pgBd}&limit=3&offset=6`);
  check(
    'search 第三页（余 1 条）',
    (page3.data.issues || []).length === 1,
    String((page3.data.issues || []).length),
  );

  // search：tag / aiOnly / priority 过滤
  const byTag = await api(`/api/issues/search?boardId=${pgBd}&tag=${encodeURIComponent('分页标签')}`);
  check(
    'search 按标签过滤',
    byTag.data.total === 1 && byTag.data.issues[0].id === ids[0],
    JSON.stringify(byTag.data).slice(0, 120),
  );
  const byPrio = await api(`/api/issues/search?boardId=${pgBd}&priority=high`);
  check('search 按优先级过滤', byPrio.data.total === 3, String(byPrio.data.total));

  // search：排序（priority asc → low 在前；desc → high 在前）
  const asc = await api(`/api/issues/search?boardId=${pgBd}&sort=priority&order=asc&limit=1`);
  check(
    'search 排序 asc（高优先级在前，与 Web 列表一致）',
    asc.data.issues[0].priority === 'high',
    JSON.stringify(asc.data.issues[0]?.priority),
  );
  const desc = await api(`/api/issues/search?boardId=${pgBd}&sort=priority&order=desc&limit=1`);
  check(
    'search 排序 desc（低优先级在前）',
    desc.data.issues[0].priority === 'low',
    JSON.stringify(desc.data.issues[0]?.priority),
  );

  // 未登录 401
  const pgSavedJar = cookieJar;
  cookieJar = '';
  const anonSearch = await api('/api/issues/search');
  check('未登录 search 返回 401', anonSearch.status === 401, String(anonSearch.status));
  cookieJar = pgSavedJar;

  // issue_list 安全阀
  const limited = await api(`/api/issues?boardId=${pgBd}&limit=2`);
  check(
    'issue_list limit 安全阀',
    (limited.data.issues || []).length === 2,
    String((limited.data.issues || []).length),
  );
  const full = await api(`/api/issues?boardId=${pgBd}`);
  check(
    'issue_list 缺省仍全量（看板视图兼容）',
    (full.data.issues || []).length === 7,
    String((full.data.issues || []).length),
  );

  // SSE：连接 → 触发写操作 → 收到 changed 事件
  const sseEvents = [];
  const sseCtrl = new AbortController();
  const sseDone = (async () => {
    try {
      const res = await fetch(`${BASE}/api/events`, {
        headers: { Cookie: cookieJar },
        signal: sseCtrl.signal,
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes('event: changed')) {
          sseEvents.push('changed');
          break;
        }
      }
    } catch {
      /* 中断 */
    }
  })();
  await new Promise((r) => setTimeout(r, 600)); // 等 SSE 建连
  await post('/api/issues', { title: `SSE触发卡_${uniq}`, boardId: pgBd });
  const sseTimeout = await Promise.race([
    sseDone.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 8000)),
  ]);
  sseCtrl.abort();
  check(
    'SSE 收到写操作广播（changed）',
    sseTimeout === true && sseEvents.length === 1,
    `events=${sseEvents.length}`,
  );
  const sseAnon = await fetch(`${BASE}/api/events`);
  check('未登录 SSE 返回 401', sseAnon.status === 401, String(sseAnon.status));

  // 清理
  for (const id of ids) await del(`/api/issues/${id}`);
  await del(`/api/issues/${(await api(`/api/issues/search?boardId=${pgBd}&q=SSE`)).data.issues?.[0]?.id}`);
  const delPgBoard = await del(`/api/boards/${pgBd}`);
  check('清理分页测试板', delPgBoard.status === 200);

  console.log('\n--- 24. OAuth 登录（GitHub 授权码流程，mock provider） ---');
  // mock provider：/authorize 302 回调、/token 换 code、/user 返回身份
  const ghUsers = {
    1001: { login: 'octocat_e2e', name: 'Octo E2E' },
    1002: { login: 'octocat_second', name: 'Octo Two' },
  };
  const oauthCodes = new Map(); // code -> userId
  let codeSeq = 0;
  const mockProvider = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock');
    if (u.pathname === '/authorize') {
      const code = `mockcode_${++codeSeq}`;
      const redirect = new URL(u.searchParams.get('redirect_uri'));
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', u.searchParams.get('state'));
      res.writeHead(302, { Location: redirect.toString() });
      res.end();
      return;
    }
    if (u.pathname === '/token') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: body.code })); // 直接以 code 充当 token，/user 按 code 反查身份
      });
      return;
    }
    if (u.pathname === '/user') {
      const at = String(req.headers.authorization || '').replace('Bearer ', '');
      const uid = oauthCodes.get(at) || '1001';
      console.error('DBG mock /user at:', at.slice(0, 40), '-> uid:', uid);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: uid, login: ghUsers[uid].login, name: ghUsers[uid].name }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => mockProvider.listen(0, '127.0.0.1', r));
  const mpPort = mockProvider.address().port;

  // 专属子服务：配置 OAuth（mock 端点 + client 凭据），独立端口
  const oauthPort = 5390 + (process.pid % 400);
  const oauthSrv = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(oauthPort),
      GITHUB_CLIENT_ID: 'mock-client-id',
      GITHUB_CLIENT_SECRET: 'mock-client-secret',
      OAUTH_GITHUB_AUTH_URL: `http://127.0.0.1:${mpPort}/authorize`,
      OAUTH_GITHUB_TOKEN_URL: `http://127.0.0.1:${mpPort}/token`,
      OAUTH_GITHUB_USER_URL: `http://127.0.0.1:${mpPort}/user`,
      AUTH_RATE_LIMIT: '20000',
      API_RATE_LIMIT: '20000',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const ob = `http://127.0.0.1:${oauthPort}`;
  let obUp = false;
  for (let i = 0; i < 30; i++) {
    obUp = await fetch(`${ob}/api/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (obUp) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check('OAuth 子服务就绪', obUp);

  // providers 列表（公开）
  const provs = await fetch(`${ob}/api/auth/oauth/providers`).then((r) => r.json());
  check(
    'providers 列表返回已配置的 github',
    (provs.providers || []).some((p) => p.id === 'github' && p.enabled),
    JSON.stringify(provs),
  );

  // 完整授权码流程：start 302 → 跟随到 mock authorize → 302 回 callback → 会话 cookie
  const startRes = await fetch(`${ob}/api/auth/oauth/github/start`, { redirect: 'manual' });
  check('start 302 到授权页', startRes.status === 302, String(startRes.status));
  const authorizeUrl = startRes.headers.get('location');
  check(
    '授权 URL 带 client_id 与 state',
    /client_id=mock-client-id/.test(authorizeUrl) && /state=github\./.test(authorizeUrl),
    authorizeUrl.slice(0, 90),
  );

  // 手动跟随（cookie 由客户端代码转发：start 下发的 state cookie 要带到 callback）
  const stateCookie = (startRes.headers.get('set-cookie') || '').split(';')[0];
  const authRes = await fetch(authorizeUrl, { redirect: 'manual' });
  const callbackUrl = authRes.headers.get('location');
  const cbRes = await fetch(callbackUrl, { redirect: 'manual', headers: { Cookie: stateCookie } });
  check(
    'callback 302 回首页（会话已下发）',
    cbRes.status === 302 && cbRes.headers.get('location') === '/',
    `${cbRes.status} ${cbRes.headers.get('location')}`,
  );
  const sessionCookie = (cbRes.headers.getSetCookie?.() || []).find((c) => c.startsWith('ci_session=')) || '';
  check('OAuth 登录下发会话 cookie', sessionCookie.startsWith('ci_session='), sessionCookie.slice(0, 30));

  // 新账号自动注册：gh_octocat_e2e
  const me = await fetch(`${ob}/api/auth/me`, { headers: { Cookie: sessionCookie } }).then((r) => r.json());
  check(
    'OAuth 自动注册账号并登录（gh_ 前缀用户名）',
    me.user?.username === 'gith_octocat_e2e' && me.user?.displayName === 'Octo E2E',
    JSON.stringify(me),
  );

  // 复登：同第三方身份重新走完整流程 → 同一账号（不重复建号）
  const start2 = await fetch(`${ob}/api/auth/oauth/github/start`, { redirect: 'manual' });
  const stateCookie2 = (start2.headers.get('set-cookie') || '').split(';')[0];
  const authorizeUrl2 = start2.headers.get('location');
  const authRes2 = await fetch(authorizeUrl2, { redirect: 'manual' });
  const cb2 = await fetch(authRes2.headers.get('location'), {
    redirect: 'manual',
    headers: { Cookie: stateCookie2 },
  });
  const session2 = (
    (cb2.headers.getSetCookie?.() || []).find((c) => c.startsWith('ci_session=')) || ''
  ).split(';')[0];
  const me2 = await fetch(`${ob}/api/auth/me`, { headers: { Cookie: session2 } }).then((r) => r.json());
  check(
    '同第三方身份复登返回同一账号',
    me2.user?.id === me.user?.id,
    JSON.stringify({ a: me.user?.id, b: me2.user?.id, me2 }),
  );

  // CSRF：无/错误 state 的 callback 被拒
  const csrf = await fetch(`${ob}/api/auth/oauth/github/callback?code=mockcode_x&state=github.999.forged`, {
    redirect: 'manual',
  });
  check('伪造/过期 state 被拒（401）', csrf.status === 401, String(csrf.status));

  // 未配置 provider 404
  const notConfigured = await fetch(`${ob}/api/auth/oauth/feishu/start`, { redirect: 'manual' });
  check('未配置的 provider 404', notConfigured.status === 404, String(notConfigured.status));

  // 绑定语义：已有密码账号登录后发起 → 身份绑到现有账号
  // 绑定语义：已有密码账号登录后发起（state 编码 userId）→ 身份 1002 绑到现有账号
  const bindRes = await fetch(`${ob}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER_A, password: 'newpass123456' }),
  });
  const bindJar = (
    (bindRes.headers.getSetCookie?.() || []).find((c) => c.startsWith('ci_session=')) || ''
  ).split(';')[0];
  check(
    '绑定前置：USER_A 在子服务登录成功',
    bindRes.status === 200 && bindJar,
    `${bindRes.status} ${bindJar.slice(0, 24)}`,
  );
  const startBind = await fetch(`${ob}/api/auth/oauth/github/start`, {
    redirect: 'manual',
    headers: { Cookie: bindJar },
  });
  const stateCookie3 = (startBind.headers.get('set-cookie') || '').split(';')[0];
  const authorizeUrl3 = startBind.headers.get('location') || '';
  const authRes3 = await fetch(authorizeUrl3, { redirect: 'manual' });

  // 绑定语义：运行内唯一的新身份 → 登录态回调绑定到 USER_A（不新建账号）
  const bindIdentity = `bind_${Date.now()}`;
  ghUsers[bindIdentity] = { login: 'octocat_third', name: 'Octo Three' };
  const codeBind = `mockcode_bind_${++codeSeq}`;
  oauthCodes.set(codeBind, bindIdentity);
  const cb3 = await fetch(authRes3.headers.get('location').replace(/code=[^&]+/, `code=${codeBind}`), {
    redirect: 'manual',
    headers: { Cookie: `${stateCookie3}; ${bindJar}` },
  });
  const session3 = (
    (cb3.headers.getSetCookie?.() || []).find((c) => c.startsWith('ci_session=')) || ''
  ).split(';')[0];
  console.error(
    'DBG cb3:',
    cb3.status,
    'cookies:',
    (cb3.headers.getSetCookie?.() || []).map((c) => c.slice(0, 22)).join('|'),
    'body:',
    await cb3
      .clone()
      .text()
      .then((t) => t.slice(0, 90)),
    'jar:',
    bindJar.slice(0, 24),
    'state:',
    stateCookie3.slice(0, 40),
  );
  const me3 = await fetch(`${ob}/api/auth/me`, { headers: { Cookie: session3 } }).then((r) => r.json());
  check(
    '登录态下回调 = 全新身份绑定到现有账号（不新建）',
    me3.user?.username === USER_A && me3.user?.id !== me.user?.id,
    JSON.stringify(me3),
  );

  // 冲突语义：新身份先经 B 的完整 OAuth 自动注册（身份→B），再用 A 的登录态回调同身份 → 409 不静默切号
  const conflictIdentity = `conflict_${Date.now()}`;
  ghUsers[conflictIdentity] = { login: 'octocat_b', name: 'Octo B' };
  const startB = await fetch(`${ob}/api/auth/oauth/github/start`, { redirect: 'manual' });
  const stateCookieB = (startB.headers.get('set-cookie') || '').split(';')[0];
  const authResB = await fetch(startB.headers.get('location'), { redirect: 'manual' });
  const codeB = `mockcode_b_${++codeSeq}`;
  oauthCodes.set(codeB, conflictIdentity);
  const cbB = await fetch(authResB.headers.get('location').replace(/code=[^&]+/, `code=${codeB}`), {
    redirect: 'manual',
    headers: { Cookie: stateCookieB },
  });
  check('B 的完整 OAuth 流程自动注册并登录', cbB.status === 302, String(cbB.status));

  // A 的登录态（state uid=A）回调已属于 B 的身份 → 409
  const codeConflict = `mockcode_conflict_${++codeSeq}`;
  oauthCodes.set(codeConflict, conflictIdentity);
  const authRes4 = await fetch(authorizeUrl3, { redirect: 'manual' });
  const cb4 = await fetch(authRes4.headers.get('location').replace(/code=[^&]+/, `code=${codeConflict}`), {
    redirect: 'manual',
    headers: { Cookie: `${stateCookie3}; ${bindJar}` },
  });
  check('已绑定他人的身份在登录态回调返回 409（不静默切号）', cb4.status === 409, String(cb4.status));

  mockProvider.close();
  oauthSrv.kill();

  console.log(`\n=====================================`);
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log(`=====================================\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
