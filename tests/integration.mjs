/**
 * 端到端集成测试：验证 HTTP → MCP → MySQL 全链路与全部业务规则。
 * 运行前需先启动服务（认证套件会发起大量登录尝试，请调高认证限流）：
 *   AUTH_RATE_LIMIT=10000 node server/index.js
 */
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

  console.log(`\n=====================================`);
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log(`=====================================\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
