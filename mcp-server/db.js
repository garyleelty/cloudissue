import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..');

// MCP Server 以子进程方式启动，需要显式从项目根目录读取 .env
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

const {
  DB_HOST = '127.0.0.1',
  DB_PORT = '3306',
  DB_USER = 'root',
  DB_PASSWORD = '',
  DB_NAME = 'issue_board',
} = process.env;

export const dbConfig = {
  host: DB_HOST,
  port: Number(DB_PORT),
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  multipleStatements: true,
};

export const pool = mysql.createPool(dbConfig);

const SAFE_IDENT = /^[A-Za-z0-9_$]+$/;

/**
 * 建库。刻意使用「不指定 database」的独立连接执行：
 * 首次启动时目标库可能尚不存在，若用主连接池会直接报 ER_BAD_DB_ERROR。
 */
export async function ensureDatabase() {
  if (!SAFE_IDENT.test(DB_NAME)) {
    throw new Error(`非法的数据库名 "${DB_NAME}"，仅允许字母、数字、下划线与 $`);
  }
  const rootConfig = { ...dbConfig };
  delete rootConfig.database;

  const admin = mysql.createPool(rootConfig);
  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`
         DEFAULT CHARACTER SET utf8mb4
         DEFAULT COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await admin.end();
  }
}

export const SCHEMA_PATH = path.join(PROJECT_ROOT, 'db', 'schema.sql');

/** 执行建表脚本（幂等） */
export async function runSchema() {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  await pool.query(sql);
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
