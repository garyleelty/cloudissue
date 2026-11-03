import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..');

// MCP Server 以子进程方式启动，需要显式从项目根目录读取 .env
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

/** 环境变量 fail-fast 校验：配置错误应让进程立刻退出，而不是运行期莫明失败 */
const EnvSchema = z.object({
  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().max(65535).default(3306),
  DB_USER: z.string().min(1, 'DB_USER 不能为空（生产环境禁止默认 root 空密码）'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_$]+$/, 'DB_NAME 仅允许字母、数字、下划线与 $')
    .default('issue_board'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  for (const issue of parsed.error.issues) {
    console.error(`[cloudissue-mcp] 环境变量错误 ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}
const env = parsed.data;

export const dbConfig = {
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  // 有界排队：数据库不可用时请求应快速失败，而不是在队列里无限堆积
  queueLimit: 100,
  connectTimeout: 10_000,
  enableKeepAlive: true,
  charset: 'utf8mb4',
  // 刻意不开启 multipleStatements：业务查询全部参数化，但多语句会放大
  // 注入面；建表脚本需要多语句，由 runSchema 里的临时专用连接承担。
};

export const pool = mysql.createPool(dbConfig);

const SAFE_IDENT = /^[A-Za-z0-9_$]+$/;

/**
 * 建库。刻意使用「不指定 database」的独立连接执行：
 * 首次启动时目标库可能尚不存在，若用主连接池会直接报 ER_BAD_DB_ERROR。
 */
export async function ensureDatabase() {
  if (!SAFE_IDENT.test(env.DB_NAME)) {
    throw new Error(`非法的数据库名 "${env.DB_NAME}"，仅允许字母、数字、下划线与 $`);
  }
  const rootConfig = { ...dbConfig };
  delete rootConfig.database;

  const admin = mysql.createPool(rootConfig);
  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${env.DB_NAME}\`
         DEFAULT CHARACTER SET utf8mb4
         DEFAULT COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await admin.end();
  }
}

export const SCHEMA_PATH = path.join(PROJECT_ROOT, 'db', 'schema.sql');

/** 执行建表脚本（幂等）。脚本含多条语句，使用临时专用连接，用完即弃 */
export async function runSchema() {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const conn = await mysql.createConnection({ ...dbConfig, multipleStatements: true });
  try {
    await conn.query(sql);
  } finally {
    await conn.end();
  }
}

/** 单条查询 */
export function query(sql, params) {
  return pool.query(sql, params);
}

/** 事务包装 */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * 关闭连接池。HTTP 层优雅停机会先关 MCP client（stdin 关闭），
 * 这里由 stdin 的 end 事件触发，保证进程能干净退出。
 */
export async function closeDb() {
  await pool.end().catch(() => {});
}
