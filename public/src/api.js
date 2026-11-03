/**
 * REST API 封装。所有请求最终都会经由服务端转发到 MCP 数据服务。
 *
 * 这里是写操作的唯一收口，所以「通知其他标签页」挂在成功的非 GET 请求上，
 * 不必在每个调用点（新建 / 编辑 / 删除 / 移动）各写一遍。
 */
import { bumpRevision } from './sync.js';

const TIMEOUT_MS = 10_000;

async function request(url, options = {}) {
  // 网络异常要归一化成可读中文：fetch 原生抛的是英文 TypeError
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      ...options,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw Object.assign(new Error('请求超时，请检查网络后重试'), { status: 0 });
    }
    throw Object.assign(new Error('网络异常，请检查连接后重试'), { status: 0 });
  } finally {
    clearTimeout(timer);
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 空响应 */
  }

  // 带上状态码：409（乐观锁冲突）需要和其它失败区分开处理；
  // 401（会话失效）广播给入口层切换到登录视图
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('ci:unauthorized'));
    throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), {
      status: res.status,
    });
  }

  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET') bumpRevision();

  return data;
}

export const api = {
  // ---- 认证 ----
  me: () => request('/api/auth/me'),
  /** @param {{ username: string, password: string }} payload */
  login: (payload) => request('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
  /** @param {{ username: string, password: string, displayName?: string }} payload */
  register: (payload) => request('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  /** @param {{ oldPassword: string, newPassword: string }} payload */
  changePassword: (payload) =>
    request('/api/auth/password', { method: 'PUT', body: JSON.stringify(payload) }),

  // ---- 基础 ----
  health: () => request('/api/health'),
  list: () => request('/api/issues'),
  /** @param {Record<string, unknown>} payload */
  create: (payload) => request('/api/issues', { method: 'POST', body: JSON.stringify(payload) }),
  /**
   * @param {number} id
   * @param {Record<string, unknown>} payload
   */
  update: (id, payload) => request(`/api/issues/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  /**
   * @param {number} id
   * @param {{ toStatus: string, afterId?: number | null, failReason?: string, expectedVersion?: number }} payload
   */
  move: (id, payload) => request(`/api/issues/${id}/move`, { method: 'POST', body: JSON.stringify(payload) }),
  /** @param {number} id */
  remove: (id) => request(`/api/issues/${id}`, { method: 'DELETE' }),

  // 批量操作：一次请求处理一组卡片，服务端内部仍逐个走 MCP tools
  /**
   * @param {{ id: number, expectedVersion?: number }[]} items 逐卡携带乐观锁版本号
   * @param {{ toStatus: string, failReason?: string }} payload
   */
  batchMove: (items, payload) =>
    request('/api/issues/batch/move', {
      method: 'POST',
      body: JSON.stringify({ items, ...payload }),
    }),
  /** @param {number[]} ids */
  batchRemove: (ids) =>
    request('/api/issues/batch/delete', { method: 'POST', body: JSON.stringify({ ids }) }),
};
