/**
 * MCP 链路冒烟测试：验证 MCP Client 能通过 stdio 连上 MCP Server，
 * 并且全部 tools 均已正确注册（含 zod schema 校验通过）。
 * 该测试不依赖 MySQL 数据，只验证「传输 + 工具注册」这一段。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const ENTRY = path.join(ROOT, 'mcp-server', 'index.js');

const EXPECTED = [
  // 看板
  'db_health',
  'board_bootstrap',
  'board_list',
  'board_create',
  'board_delete',
  'member_list',
  'member_add',
  'member_remove',
  // 站内通知
  'notification_list',
  'notification_unread_count',
  'notification_read',
  'notification_read_all',
  'issue_list',
  'issue_get',
  'issue_search',
  'board_summary',
  'issue_create',
  'issue_update',
  'issue_move',
  'issue_delete',
  'issue_comment_add',
  'issue_comment_delete',
  // 用户与认证
  'user_create',
  'user_list',
  'user_get_by_username',
  'user_get_by_token',
  'user_get_by_id',
  'user_bump_token_version',
  'user_update_auth',
  'user_set_api_token',
];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [ENTRY],
  cwd: ROOT,
  stderr: 'pipe',
  // SDK 默认只继承 HOME/PATH 等白名单变量，DB_* 传不进去——CI 上没有 .env
  // 文件兜底，子进程会因环境校验失败直接退出（Connection closed）。显式透传。
  env: { ...process.env },
});

const client = new Client({ name: 'cloudissue-smoke', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);

console.log(`已注册 tools（${names.length} 个）:`, names.join(', '));

const missing = EXPECTED.filter((n) => !names.includes(n));
if (missing.length) {
  console.error('缺少 tools:', missing.join(', '));
  process.exitCode = 1;
} else {
  console.log(`OK: 全部 ${EXPECTED.length} 个 tools 注册正常`);
}

// 校验 issue_move 的入参 schema 已生成（含乐观锁与 actor）
const move = tools.find((t) => t.name === 'issue_move');
const props = Object.keys(move?.inputSchema?.properties ?? {});
console.log('issue_move 入参:', props.join(', '));
if (
  !props.includes('toStatus') ||
  !props.includes('afterId') ||
  !props.includes('failReason') ||
  !props.includes('actor')
) {
  console.error('issue_move 入参 schema 不完整');
  process.exitCode = 1;
}

await client.close();
process.exit(process.exitCode ?? 0);
