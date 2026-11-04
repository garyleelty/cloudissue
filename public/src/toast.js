/**
 * 轻量 toast 提示。
 * 连续的相同文案不重复堆叠（如轮询失败会每个周期弹一条，很快糊满屏幕）：
 * 已有同文案的 toast 时重置其计时器并置顶即可。
 */

const root = document.querySelector('#toastRoot');

/**
 * @param {string} message 提示文案
 * @param {'' | 'error' | 'success'} [type] 类型，影响配色与停留时长
 */
export function toast(message, type = '') {
  // 同文案去重：刷新已有 toast 的存活时间，避免重复请求失败刷屏
  for (const existing of [...root.querySelectorAll('.toast')]) {
    if (existing.textContent !== message) continue;
    if (existing.dataset.type !== type) continue;
    root.appendChild(existing); // 移到队尾保持最新语义
    clearTimeout(Number(existing.dataset.timer));
    arm(existing, type);
    return;
  }

  const el = document.createElement('div');
  el.className = `toast ${type}`.trim();
  el.textContent = message;
  el.dataset.type = type;
  root.appendChild(el);
  arm(el, type);
}

/** @param {HTMLElement} el @param {string} type */
function arm(el, type) {
  const remove = () => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 300);
  };
  el.dataset.timer = String(setTimeout(remove, type === 'error' ? 3600 : 2200));
}
