/**
 * 进程内事件总线：Web 写路由即时广播、分发器兜底广播（AI 动作），
 * SSE 端点（/api/events）订阅后推给浏览器——替代 30s 轮询的实时性来源。
 * 单实例部署语义；多实例时各进程的总线独立（SSE 客户端连哪个实例就收
 * 哪个实例的即时事件，跨实例变化由分发器轮询兜底补齐，延迟 ≤ 轮询周期）。
 */
import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(100); // SSE 长连接每个客户端一个 listener

/** 写操作后广播（Fire-and-forget，绝不让广播失败影响主流程） */
export function broadcastChanged(source = 'http') {
  try {
    bus.emit('changed', { source, at: Date.now() });
  } catch {
    /* 总线失败不影响主流程 */
  }
}

/** @returns {() => void} 取消订阅函数 */
export function onChanged(fn) {
  bus.on('changed', fn);
  return () => bus.off('changed', fn);
}
