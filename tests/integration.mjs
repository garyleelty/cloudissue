/**
 * 端到端集成测试：验证 HTTP → MCP → MySQL 全链路与全部业务规则。
 * 运行前需先启动服务：node server/index.js
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
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, data };
}

const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body) });
const put = (p, body) => api(p, { method: 'PUT', body: JSON.stringify(body) });
const del = (p) => api(p, { method: 'DELETE' });

async function getIssue(id) {
  const { data } = await api('/api/issues');
  return (data.issues || []).find((i) => i.id === id);
}

async function main() {
  console.log('\n--- 1. 健康检查（经 MCP） ---');
  const health = await api('/api/health');
  check('健康检查通过', health.status === 200 && health.data.connected === true);
  check('确认经由 MCP 链路', health.data.viaMcp === true);
  check('连接的库为 issue_board', health.data.db === 'issue_board', health.data.db);

  console.log('\n--- 2. 示例数据初始化 ---');
  const list0 = await api('/api/issues');
  const issues0 = list0.data.issues || [];
  check('已写入 10 条示例任务', issues0.length === 10, String(issues0.length));
  const statuses = new Set(issues0.map((i) => i.status));
  check('覆盖全部五列', statuses.size === 5, [...statuses].join(','));
  const prios = new Set(issues0.map((i) => i.priority));
  check('覆盖三档优先级', prios.size === 3, [...prios].join(','));

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
  check('标签正确写入', JSON.stringify(created.data.issue.tags) === JSON.stringify(['测试', '集成']), JSON.stringify(created.data.issue.tags));
  check('新建即产生一条变更记录', created.data.issue.logs.length === 1, String(created.data.issue.logs.length));
  check('新建记录的 fromStatus 为空', created.data.issue.logs[0].fromStatus === '', JSON.stringify(created.data.issue.logs[0]));

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
  check('记录了状态变化', good.data.statusChanged === true && good.data.fromStatus === 'backlog', JSON.stringify(good.data));

  const moved = await getIssue(id);
  check('状态已变为 failed', moved.status === 'failed', moved.status);
  const lastLog = moved.logs[moved.logs.length - 1];
  check('变更记录写入了原状态与新状态', lastLog.fromStatus === 'backlog' && lastLog.toStatus === 'failed', JSON.stringify(lastLog));
  check('变更记录写入了失败原因', lastLog.reason === reason, lastLog.reason);
  check('变更记录带时间戳', Boolean(lastLog.changedAt), lastLog.changedAt);

  console.log('\n--- 6. 排序（afterId） ---');
  const a = await post('/api/issues', { title: '排序A', status: 'done', priority: 'low' });
  const b = await post('/api/issues', { title: '排序B', status: 'done', priority: 'low' });
  const c = await post('/api/issues', { title: '排序C', status: 'done', priority: 'low' });
  // 把 C 插到 A 之后：期望 A, C, B
  await post(`/api/issues/${c.data.id}/move`, { toStatus: 'done', afterId: a.data.id });
  const { data: dl } = await api('/api/issues');
  const doneOrder = dl.issues.filter((i) => ['排序A', '排序B', '排序C'].includes(i.title)).map((i) => i.title);
  check('afterId 排序生效（期望 A,C,B）', JSON.stringify(doneOrder) === JSON.stringify(['排序A', '排序C', '排序B']), JSON.stringify(doneOrder));
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
  check('标签被整体替换', JSON.stringify(upd.data.issue.tags) === JSON.stringify(['改过的标签']), JSON.stringify(upd.data.issue.tags));
  check('离开失败列产生新记录', upd.data.issue.logs.some((l) => l.fromStatus === 'failed' && l.toStatus === 'planning'));

  console.log('\n--- 8. 更新到失败列同样要求原因 ---');
  const badUpdate = await put(`/api/issues/${id}`, { status: 'failed' });
  check('编辑时改为失败但未填原因被拒绝', badUpdate.status === 400, JSON.stringify(badUpdate.data));

  console.log('\n--- 9. 删除与级联清理 ---');
  const delRes = await del(`/api/issues/${id}`);
  check('删除返回 200', delRes.status === 200 && delRes.data.deleted === true, JSON.stringify(delRes.data));
  const { data: afterDel } = await api('/api/issues');
  check('任务已从列表移除', !afterDel.issues.some((i) => i.id === id));
  check('总数回到 10（未被重复初始化）', afterDel.issues.length === 10, String(afterDel.issues.length));

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
  check('更新后版本号 +1', okUpd.data.issue.version === any.version + 1, String(okUpd.data.issue && okUpd.data.issue.version));

  const staleUpd = await put(`/api/issues/${any.id}`, {
    title: `${any.title}·过期`,
    expectedVersion: any.version,
  });
  check('版本号过期时更新返回 409', staleUpd.status === 409, JSON.stringify(staleUpd.data));
  check('冲突提示说明原因', /已被其他人修改/.test(staleUpd.data.error || ''), staleUpd.data.error);
  check('冲突响应带回当前版本号', staleUpd.data.currentVersion === any.version + 1, String(staleUpd.data.currentVersion));

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
  check('版本号一致时移动成功', okMove.status === 200 && okMove.data.moved === true, JSON.stringify(okMove.data));

  // 复原现场：清掉本组改动，避免污染后续轮次的示例数据
  await put(`/api/issues/${any.id}`, { title: any.title });
  const restored = await getIssue(any.id);
  check('冲突未覆盖他人改动（标题仍是最新值）', restored.title !== `${any.title}·过期`, restored.title);

  console.log(`\n=====================================`);
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log(`=====================================\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
