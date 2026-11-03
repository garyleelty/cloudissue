import pino from 'pino';

/** 结构化日志（JSON 行）。MCP 子进程自行写 stderr，这里只管 HTTP 层 */
export const logger = pino({ level: process.env.LOG_LEVEL || 'info', base: { svc: 'cloudissue-http' } });
