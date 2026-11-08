// 前后端共用的 Git 提交关联提取规则（单一口径）：
//   · HTTP 层 GitHub webhook 用它从 push commits 里提取 #编号 关联；
//   · 抽屉 UI 用它高亮提交信息里的 #编号 与仓库链接。
// 该文件同时被 Node 端（ESM）与浏览器端（<script type="module">）加载，只能纯函数。

/**
 * 从文本中提取 issue 编号引用（#N，N 为正整数；忽略行内代码与 URL 中的 #）。
 * @param {string} text
 * @returns {number[]} 去重后的编号列表，按出现顺序
 */
export function extractIssueRefs(text) {
  const out = [];
  const seen = new Set();
  const src = String(text ?? '')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  for (const m of src.matchAll(/(?:^|[^#\w])#(\d{1,9})(?![\w])/g)) {
    const n = Number(m[1]);
    if (n > 0 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * GitHub push 事件 → 关联记录列表。
 * 只取默认分支或给定分支的 push；每个 commit 按其 message 里的 #编号拆成多条。
 * @param {{ repository?: { full_name?: string }, ref?: string, commits?: Array<{ id?: string, message?: string, author?: { name?: string }, timestamp?: string }>, pusher?: { name?: string } }} payload
 * @param {string} secretBranch 只关联该分支（空 = 所有分支）
 * @returns {{ repo: string, branch: string, refs: Array<{ issueId: number, hash: string, message: string, author: string, branch: string, committedAt: string | null }>} | null}
 *   payload 不合法时返回 null
 */
export function parseGithubPush(payload, secretBranch = '') {
  if (!payload || typeof payload !== 'object') return null;
  const repo = String(payload.repository?.full_name || '');
  const ref = String(payload.ref || '');
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  if (!repo || !Array.isArray(payload.commits)) return null;
  if (secretBranch && branch && branch !== secretBranch) return { repo, branch, refs: [] };

  const refs = [];
  for (const c of payload.commits || []) {
    const hash = String(c.id || '').toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(hash)) continue;
    const message = String(c.message || '')
      .split('\n')[0]
      .slice(0, 512);
    const author = String(c.author?.name || payload.pusher?.name || '').slice(0, 128);
    for (const issueId of extractIssueRefs(message)) {
      refs.push({
        issueId,
        hash,
        message,
        author,
        branch,
        committedAt: c.timestamp || null,
      });
    }
  }
  return { repo, branch, refs };
}
