// 前后端共用的受限 Markdown 渲染器（零依赖）。
// 用途：issue 描述在详情抽屉里的富文本显示——AI 客户端经 MCP 写的描述
// 几乎必然是 markdown（列表 / 代码块 / 粗体），原样显示为纯文本不可读。
//
// 安全模型（本文件的第一职责是防 XSS，其次才是排版）：
//   1. 先整行 HTML 转义，后解析标记——任何 <script>/onerror 属性都变成字面文本；
//   2. 链接 href 走白名单（http/https/mailto），其余一律丢弃只留文字；
//   3. 只产白名单标签：h1-h6/p/strong/em/del/code/pre/ul/ol/li/blockquote/br/hr/a。
// 支持子集：标题、段落、无序/有序列表（一层缩进嵌套）、引用、代码块、
// 分隔线、粗体、斜体、行内代码、删除线、链接、自动链接（http(s)://）。

/** HTML 转义：所有内容进入渲染管线前必须经过它 */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** href 白名单：javascript:/data: 等危险协议直接拒绝 */
function safeHref(url) {
  const u = String(url || '').trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
}

/** 行内标记解析（输入与输出均为已转义文本） */
function inline(text) {
  let s = text;
  // 行内代码优先：先抽出占位，防止其内容被后续规则二次加工
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\uE000${codes.length - 1}\uE000`;
  });
  // 链接 [text](url)——url 未转义引号前已处理，白名单校验后放行
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const href = safeHref(url.replace(/&amp;/g, '&'));
    return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : m;
  });
  // 自动链接 http(s)://…
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)"']+)/g, (m, pre, url) => {
    const href = safeHref(url);
    return href ? `${pre}<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>` : m;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\uE000(\d+)\uE000/g, (_, i) => codes[Number(i)]);
}

/**
 * 受限 Markdown → 安全 HTML。
 * @param {string} raw 原始 markdown 文本
 * @returns {string} 可直接 innerHTML 的安全 HTML
 */
export function renderMarkdown(raw) {
  const lines = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag: 'ul' | 'ol', items: string[] }
  let quote = [];
  let code = null; // { lang: string, lines: string[] }

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ');

    // 代码块围栏：内容整体转义，不做任何行内解析
    const fence = line.match(/^```\s*([A-Za-z0-9_-]*)\s*$/);
    if (code) {
      if (fence) {
        out.push(
          `<pre><code${code.lang ? ` class="lang-${escapeHtml(code.lang)}"` : ''}>${escapeHtml(code.lines.join('\n'))}</code></pre>`,
        );
        code = null;
      } else {
        code.lines.push(rawLine);
      }
      continue;
    }
    if (fence) {
      flushAll();
      code = { lang: fence[1], lines: [] };
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(escapeHtml(heading[2].trim()))}</h${level}>`);
      continue;
    }

    // 分隔线
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushAll();
      out.push('<hr>');
      continue;
    }

    // 引用
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      flushPara();
      flushList();
      quote.push(escapeHtml(q[1]));
      continue;
    }
    flushQuote();

    // 列表（两空格缩进为嵌套一层，仅支持一层）
    const li = line.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const want = /^\d/.test(li[0].trim()) ? 'ol' : 'ul';
      if (!list || list.tag !== want) {
        flushList();
        list = { tag: want, items: [] };
      }
      const content = escapeHtml(li[2].trim());
      if (li[1].length >= 2 && list.items.length) {
        // 一层嵌套：并入上一项
        list.items[list.items.length - 1] += `<ul><li>${inline(content)}</li></ul>`;
      } else {
        list.items.push(content);
      }
      continue;
    }
    flushList();

    // 空行分段
    if (!line.trim()) {
      flushAll();
      continue;
    }

    para.push(escapeHtml(line));
  }

  // 收尾
  if (code) {
    out.push(
      `<pre><code${code.lang ? ` class="lang-${escapeHtml(code.lang)}"` : ''}>${escapeHtml(code.lines.join('\n'))}</code></pre>`,
    );
  }
  flushAll();
  return out.join('\n');
}
