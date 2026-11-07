#!/bin/sh
# ---------------------------------------------------------------
# CloudIssue · 恢复验证
# ---------------------------------------------------------------
# 没有验证过恢复的备份等于没有备份。本脚本把一份备份导入一个隔离的
# MySQL 环境，然后做三层校验：
#   1. 结构：核心表全部存在；
#   2. 数据：各表行数与备份时生成的 manifest 完全一致；
#   3. 一致性：子表无孤儿行（外键虽在 dump 里重建，这里按数据再验一遍）。
#
# 两种隔离模式：
#   1. VERIFY_HOST/VERIFY_PORT/VERIFY_USER/VERIFY_PASSWORD 给定 → 在运行中的
#      实例上建 verify_<时间戳> 独立数据库导入校验，结束后 DROP（CI 推荐，
#      无需 mysqld 环境依赖）；
#   2. 未给定时本机起临时 mysqld 实例（独立 datadir，需 MYSQLD_BIN 可用）。
#
# 用法：scripts/restore-verify.sh <cloudissue-*.sql.gz>
# 退出码：0 验证通过；非 0 失败。
# ---------------------------------------------------------------
set -eu

if [ $# -lt 1 ]; then
  echo "用法: $0 <cloudissue-*.sql.gz>" >&2
  exit 1
fi
BACKUP_SQL=$1
[ -f "$BACKUP_SQL" ] || { echo "[verify] 错误：备份文件不存在 $BACKUP_SQL" >&2; exit 1; }
MANIFEST="${BACKUP_SQL%.sql.gz}.manifest.json"
[ -f "$MANIFEST" ] || { echo "[verify] 错误：缺少 manifest ${MANIFEST}（备份产物不完整）" >&2; exit 1; }
MANIFEST_ABS=$(CDPATH= cd -- "$(dirname -- "$MANIFEST")" && pwd)/$(basename -- "$MANIFEST")

MYSQL_BIN=${MYSQL_BIN:-mysql}
PASS=0
FAIL=0
MYSQLD_PID=

cleanup() {
  if [ -n "${VERIFY_DB:-}" ]; then
    $VCLIENT -e "DROP DATABASE IF EXISTS $VERIFY_DB" 2>/dev/null || true
  fi
  if [ -n "$MYSQLD_PID" ]; then
    kill "$MYSQLD_PID" 2>/dev/null || true
    wait 2>/dev/null || true
    rm -rf "${TMPDIR_V:-}"
  fi
}
trap cleanup EXIT

# ================================================================
# 导入（两种模式二选一）
# ================================================================
if [ -n "${VERIFY_HOST:-}" ]; then
  # ---- 模式一：复用运行中实例，独立 database 做隔离（CI 推荐） ----
  VERIFY_PORT=${VERIFY_PORT:-3306}
  VERIFY_USER=${VERIFY_USER:-root}
  VERIFY_DB="verify_$(date +%s)_$$"
  VCLIENT="$MYSQL_BIN -h$VERIFY_HOST -P$VERIFY_PORT -u$VERIFY_USER"
  if [ -n "${VERIFY_PASSWORD:-}" ]; then VCLIENT="$VCLIENT -p$VERIFY_PASSWORD"; fi

  $VCLIENT -e "CREATE DATABASE $VERIFY_DB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" || {
    echo "[verify] 错误：无法在 $VERIFY_HOST:$VERIFY_PORT 创建验证库" >&2
    exit 1
  }
  echo "[verify] 复用实例 $VERIFY_HOST:${VERIFY_PORT}，验证库 $VERIFY_DB"
  gzip -dc "$BACKUP_SQL" | $VCLIENT "$VERIFY_DB"
  echo "[verify] 导入完成，开始校验"
  MYSQL_Q="$VCLIENT -N -B -D $VERIFY_DB"
else
  # ---- 模式二：本机临时 mysqld 实例（独立 datadir，不碰生产库） ----
  MYSQLD_BIN=${MYSQLD_BIN:-$(command -v mysqld || true)}
  [ -n "$MYSQLD_BIN" ] || { echo "[verify] 错误：找不到 mysqld（可设 MYSQLD_BIN 指定路径）" >&2; exit 1; }

  TMPDIR_V=$(mktemp -d /tmp/cloudissue-verify.XXXXXX)
  DATADIR="$TMPDIR_V/data"
  SOCK="$TMPDIR_V/mysql.sock"
  PORT_V=${VERIFY_PORT_LOCAL:-33077}
  mkdir -p "$DATADIR"
  echo "[verify] 临时实例：datadir=$DATADIR port=$PORT_V"

  "$MYSQLD_BIN" --initialize-insecure --datadir="$DATADIR" >/dev/null 2>&1
  "$MYSQLD_BIN" --datadir="$DATADIR" --socket="$SOCK" --port="$PORT_V" \
    --bind-address=127.0.0.1 --mysqlx=0 \
    --pid-file="$TMPDIR_V/mysqld.pid" >/dev/null 2>&1 &
  MYSQLD_PID=$!

  for i in $(seq 1 30); do
    "$MYSQL_BIN" --socket="$SOCK" -uroot -e 'SELECT 1' >/dev/null 2>&1 && break
    sleep 0.5
  done
  "$MYSQL_BIN" --socket="$SOCK" -uroot -e 'SELECT 1' >/dev/null 2>&1 || {
    echo "[verify] 错误：临时 MySQL 未能在 15s 内就绪" >&2
    exit 1
  }
  "$MYSQL_BIN" --socket="$SOCK" -uroot -e 'CREATE DATABASE issue_board CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;'
  gzip -dc "$BACKUP_SQL" | "$MYSQL_BIN" --socket="$SOCK" -uroot issue_board
  echo "[verify] 导入完成，开始校验"
  MYSQL_Q="$MYSQL_BIN --socket=$SOCK -uroot -N -B issue_board"
fi

# ================================================================
# 校验（两种模式共用）
# ================================================================

# ---- 3) 结构校验：核心表齐全 ----
EXPECTED_TABLES="issues users boards board_members issue_tags issue_status_logs issue_comments notifications board_meta"
for t in $EXPECTED_TABLES; do
  found=$($MYSQL_Q -e "SHOW TABLES LIKE '$t'" | head -1)
  if [ "$found" = "$t" ]; then
    echo "  PASS  表存在：$t"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  表存在：$t"
    FAIL=$((FAIL + 1))
  fi
done

# ---- 4) 数据校验：行数与 manifest 一致 ----
for t in $EXPECTED_TABLES; do
  actual=$($MYSQL_Q -e "SELECT COUNT(*) FROM \`$t\`")
  expected=$(MANIFEST="$MANIFEST_ABS" node -e "const m=JSON.parse(require('fs').readFileSync(process.env.MANIFEST,'utf8')); process.stdout.write(String(m.tables['$t'] ?? 'MISSING'))")
  if [ "$expected" = "MISSING" ]; then
    echo "  FAIL  行数比对：${t}（manifest 缺少该表）"
    FAIL=$((FAIL + 1))
  elif [ "$actual" = "$expected" ]; then
    echo "  PASS  行数一致：$t = $actual"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  行数不一致：$t 期望 $expected 实际 $actual"
    FAIL=$((FAIL + 1))
  fi
done

# ---- 5) 一致性校验：子表无孤儿行（有结果行 = 有孤儿 = FAIL） ----
check_orphan() { # check_orphan <名称> <SQL>
  name=$1; sql=$2
  orphan=$($MYSQL_Q -e "$sql" | head -1)
  if [ -z "$orphan" ]; then
    echo "  PASS  $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  ${name}（样例：${orphan}）"
    FAIL=$((FAIL + 1))
  fi
}

check_orphan '无孤儿：issue_tags → issues' 'SELECT t.issue_id FROM issue_tags t LEFT JOIN issues i ON i.id = t.issue_id WHERE i.id IS NULL LIMIT 1'
check_orphan '无孤儿：issue_status_logs → issues' 'SELECT t.issue_id FROM issue_status_logs t LEFT JOIN issues i ON i.id = t.issue_id WHERE i.id IS NULL LIMIT 1'
check_orphan '无孤儿：issue_comments → issues' 'SELECT t.issue_id FROM issue_comments t LEFT JOIN issues i ON i.id = t.issue_id WHERE i.id IS NULL LIMIT 1'
check_orphan '无孤儿：board_members → boards' 'SELECT t.board_id FROM board_members t LEFT JOIN boards b ON b.id = t.board_id WHERE b.id IS NULL LIMIT 1'
check_orphan '无孤儿：notifications → issues' 'SELECT t.issue_id FROM notifications t LEFT JOIN issues i ON i.id = t.issue_id WHERE i.id IS NULL LIMIT 1'

echo "[verify] 结果：通过 $PASS 项，失败 $FAIL 项"
[ "$FAIL" -eq 0 ]
