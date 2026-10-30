/**
 * REST API 封装。所有请求最终都会经由服务端转发到 MCP 数据服务。
 */

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

  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
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
};
