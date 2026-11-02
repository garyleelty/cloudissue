/**
 * REST API 封装。所有请求最终都会经由服务端转发到 MCP 数据服务。
 *
 * 这里是写操作的唯一收口，所以「通知其他标签页」挂在成功的非 GET 请求上，
 * 不必在每个调用点（新建 / 编辑 / 删除 / 移动）各写一遍。
 */
import { bumpRevision } from './sync.js';

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 空响应 */
  }

  // 带上状态码：409（乐观锁冲突）需要和其它失败区分开处理
  if (!res.ok) throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), { status: res.status });

  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET') bumpRevision();

  return data;
}

export const api = {
  health: () => request('/api/health'),
  list: () => request('/api/issues'),
  /** @param {Record<string, unknown>} payload */
  create: (payload) =>
    request('/api/issues', { method: 'POST', body: JSON.stringify(payload) }),
  /**
   * @param {number} id
   * @param {Record<string, unknown>} payload
   */
  update: (id, payload) =>
    request(`/api/issues/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  /**
   * @param {number} id
   * @param {{ toStatus: string, afterId?: number | null, failReason?: string }} payload
   */
  move: (id, payload) =>
    request(`/api/issues/${id}/move`, { method: 'POST', body: JSON.stringify(payload) }),
  /** @param {number} id */
  remove: (id) => request(`/api/issues/${id}`, { method: 'DELETE' }),

  // 批量操作：一次请求处理一组 id，服务端内部仍逐个走 MCP tools
  /**
   * @param {number[]} ids
   * @param {{ toStatus: string, failReason?: string }} payload
   */
  batchMove: (ids, payload) =>
    request('/api/issues/batch/move', {
      method: 'POST',
      body: JSON.stringify({ ids, ...payload }),
    }),
  /** @param {number[]} ids */
  batchRemove: (ids) =>
    request('/api/issues/batch/delete', { method: 'POST', body: JSON.stringify({ ids }) }),
};
