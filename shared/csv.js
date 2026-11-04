// 前后端共用的 CSV 生成（RFC 4180：CRLF 行尾、逗号/引号/换行转义）。
// 服务端 /api/export/csv 用它生成下载文件；浏览器端测试直接断言转义规则。
// 该文件同时被 Node 端（ESM）与浏览器端（<script type="module">）加载，只能纯函数。

/** UTF-8 BOM：让 Excel / Numbers 正确识别中文 */
export const CSV_BOM = '\uFEFF';

/** @param {unknown} cell */
function escapeCell(cell) {
  const s = String(cell ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 二维表 → CSV 文本。第一行为表头；调用方决定列序与数据行。
 * @param {unknown[][]} rows
 * @returns {string}
 */
export function toCsv(rows) {
  return rows.map((row) => row.map(escapeCell).join(',')).join('\r\n');
}
