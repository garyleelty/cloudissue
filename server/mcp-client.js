/**
 * MCP Client 封装：单例、惰性连接、断连自动失效与重试。
 * HTTP 层所有数据读写（含用户认证所需查询）都经由这里的 callTool 完成。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, '..');
const MCP_ENTRY = path.join(PROJECT_ROOT, 'mcp-server', 'index.js');

let mcpClientPromise = null;

function connectMcp() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DB_HOST: process.env.DB_HOST || '127.0.0.1',
      DB_PORT: process.env.DB_PORT || '3306',
      DB_USER: process.env.DB_USER || 'root',
      DB_PASSWORD: process.env.DB_PASSWORD || '',
      DB_NAME: process.env.DB_NAME || 'issue_board',
    },
    stderr: 'inherit',
  });

  const client = new Client({ name: 'cloudissue-http', version: '1.0.0' });
  // 子进程崩溃/退出时必须失效缓存，否则所有后续调用都打在一具尸体上
  client.onclose = () => {
    if (mcpClientPromise) {
      logger.warn('mcp data server connection closed, 将在下次调用时重连');
      mcpClientPromise = null;
    }
  };
  client.onerror = (err) => {
    logger.error({ err: err.message }, 'mcp client transport error');
  };
  return client
    .connect(transport)
    .then(() => client); // connect() 的返回值不是 client，必须显式回传
}

export function getMcpClient() {
  if (!mcpClientPromise) {
    mcpClientPromise = connectMcp().catch((err) => {
      // 连接失败时清空缓存，允许下一次请求重试
      mcpClientPromise = null;
      throw err;
    });
  }
  return mcpClientPromise;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 调用一个 MCP tool 并返回解析后的 JSON。
 * - 业务校验失败（McpError InvalidParams）→ 400 + 原始文案；
 * - 子进程断连 → 失效缓存并重试一次；
 * - 其余一律视为系统故障 → 502 通用文案，细节只进日志。
 */
export async function callTool(name, args = {}, attempt = 0) {
  let res;
  try {
    const client = await getMcpClient();
    res = await client.callTool({ name, arguments: args });
  } catch (err) {
    const transient =
      err instanceof McpError && err.code === ErrorCode.ConnectionClosed
        ? true
        : /closed|not connected/i.test(String(err?.message));
    if (transient && attempt < 1) {
      mcpClientPromise = null;
      await sleep(200);
      return callTool(name, args, attempt + 1);
    }
    if (err instanceof McpError && err.code === ErrorCode.InvalidParams) {
      throw Object.assign(new Error(err.message), { status: 400 });
    }
    logger.error({ err: err.message, tool: name }, 'mcp call failed');
    throw Object.assign(new Error('数据服务暂时不可用，请稍后重试'), { status: 502 });
  }

  if (res.isError) {
    const text = res.content?.map((c) => c.text).join('\n') || '数据操作失败';
    // SDK 会把 tool 内抛出的 McpError 转成 isError 文本（带 "MCP error <code>:" 前缀）
    const m = /^MCP error (-?\d+): (.*)$/s.exec(text);
    if (m && Number(m[1]) === ErrorCode.InvalidParams) {
      // 业务校验失败：文案面向用户，直接透出
      throw Object.assign(new Error(m[2]), { status: 400 });
    }
    logger.error({ tool: name, detail: text }, 'mcp tool reported error');
    throw Object.assign(new Error('数据服务暂时不可用，请稍后重试'), { status: 502 });
  }

  const raw = res.content?.[0]?.text;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    logger.error({ tool: name }, 'mcp tool returned non-JSON payload');
    return {};
  }
}

/** 优雅停机：close() 会终止 MCP 子进程（子进程随 stdin 关闭自行清池退出） */
export async function closeMcp() {
  try {
    const client = await mcpClientPromise?.catch(() => null);
    await client?.close();
  } catch {
    /* 尽力而为 */
  }
}
