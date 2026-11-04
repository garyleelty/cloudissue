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
  /** @param {number | null} boardId 传 null 拉全部看板的任务 */
  list: (boardId = null) => request(`/api/issues${boardId ? `?boardId=${boardId}` : ''}`),
  /** 全部看板（多看板切换器） */
  boards: () => request('/api/boards'),
  /** @param {{ name: string, description?: string }} payload */
  createBoard: (payload) => request('/api/boards', { method: 'POST', body: JSON.stringify(payload) }),
  /** @param {number} id 删除看板，其下任务级联删除 */
  deleteBoard: (id) => request(`/api/boards/${id}`, { method: 'DELETE' }),
  /**
   * 导出 CSV：携带当前筛选条件，服务端与看板同口径过滤。
   * 返回 { blob, count, filename }——blob 供下载，count 供 toast 展示。
   * 不走 request()：这里要的是 Blob 与响应头，不是 JSON。
   * @param {{ boardId: number | null, q?: string, priority?: string, tag?: string, assignee?: string, aiOnly?: boolean }} params
   */
  exportCsv: async (params) => {
    const qs = new URLSearchParams();
    if (params.boardId) qs.set('boardId', String(params.boardId));
    if (params.q) qs.set('q', params.q);
    if (params.priority) qs.set('priority', params.priority);
    if (params.tag) qs.set('tag', params.tag);
    if (params.assignee) qs.set('assignee', params.assignee);
    if (params.aiOnly) qs.set('aiOnly', '1');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`/api/export/csv?${qs}`, { signal: controller.signal });
    } catch (err) {
      throw Object.assign(
        new Error(err?.name === 'AbortError' ? '请求超时，请检查网络后重试' : '网络异常，请检查连接后重试'),
        { status: 0 },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      if (res.status === 401) window.dispatchEvent(new CustomEvent('ci:unauthorized'));
      let msg = `请求失败（${res.status}）`;
      try {
        msg = (await res.json()).error || msg;
      } catch {
        /* 非 JSON 错误体 */
      }
      throw Object.assign(new Error(msg), { status: res.status });
    }

    // 中文文件名在 RFC 5987 的 filename* 里；同源响应可读
    const disposition = res.headers.get('Content-Disposition') || '';
    const utf8Name = disposition.match(/filename\*=UTF-8''([^;]+)/);
    const filename = utf8Name ? decodeURIComponent(utf8Name[1]) : 'cloudissue-export.csv';
    return {
      blob: await res.blob(),
      count: Number(res.headers.get('X-Export-Count') || 0),
      filename,
    };
  },
  /** issue 详情（含评论全文） */
  detail: (id) => request(`/api/issues/${id}`),
  /** 全部用户（负责人选择器等） */
  users: () => request('/api/users'),
  /** 添加评论，返回 { id, comments } */
  addComment: (id, body) =>
    request(`/api/issues/${id}/comments`, { method: 'POST', body: JSON.stringify({ body }) }),
  /** 删除自己的评论，返回 { deleted, comments } */
  deleteComment: (commentId, issueId) =>
    request(`/api/comments/${commentId}?issueId=${issueId}`, { method: 'DELETE' }),
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
