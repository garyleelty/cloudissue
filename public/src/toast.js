/**
 * 轻量 toast 提示。
 */

const root = document.querySelector('#toastRoot');

/**
 * @param {string} message 提示文案
 * @param {'' | 'error' | 'success'} [type] 类型，影响配色与停留时长
 */
export function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`.trim();
  el.textContent = message;
  root.appendChild(el);

  const remove = () => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 300);
  };

  setTimeout(remove, type === 'error' ? 3600 : 2200);
}
