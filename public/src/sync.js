/**
 * 跨标签页同步。
 *
 * 机制：任一标签页写库成功后往 localStorage 写一个修订号，其他标签页收到
 * `storage` 事件就重新拉一次看板。选 storage 事件而不是轮询，是为了零无效请求；
 * 它只在「其他」标签页触发、写入方自己收不到，因此天然没有自触发回环。
 *
 * 兜底：标签页切回前台时再拉一次。`storage` 事件在后台标签页可能被节流，
 * 而且换设备 / 换端改动的数据不会有任何事件通知。
 */
const REV_KEY = 'issue-board:rev';

/** 安全取 localStorage：隐私模式下访问会直接抛异常 */
function storage() {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 写库成功后调用，通知其他标签页数据已变 */
export function bumpRevision() {
  const ls = storage();
  if (!ls) return;
  try {
    ls.setItem(REV_KEY, String(Date.now()));
  } catch {
    /* 配额不足或隐私模式，同步功能降级即可，不影响主流程 */
  }
}

/**
 * 装配跨标签页同步。
 * @param {() => Promise<void>} reload 重新拉取看板（由 main.js 注入，保持单向依赖）
 */
export function initCrossTabSync(reload) {
  let timer = null;

  // 连续多条变更合并成一次拉取，避免批量操作打出一串请求
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => reload(), 80);
  };

  window.addEventListener('storage', (e) => {
    if (e.key && e.key !== REV_KEY) return;
    schedule();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    reload();
  });
}
