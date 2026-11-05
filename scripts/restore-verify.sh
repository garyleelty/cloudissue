#!/bin/sh
# ---------------------------------------------------------------
# CloudIssue · 恢复验证
# ---------------------------------------------------------------
# 没有验证过恢复的备份等于没有备份。本脚本把一份备份导入一个
# 临时 MySQL 实例（独立 datadir，不碰生产库），然后做三层校验：
#   1. 结构：核心表全部存在；
#   2. 数据：各表行数与备份时生成的 manifest 完全一致；
#   3. 一致性：子表无孤儿行（外键虽在 dump 里重建，这里按数据再验一遍）。
#
# 用法：scripts/restore-verify.sh <cloudissue-*.sql.gz>
# 环境：需要 mysqld/mysqld_safe 可执行（MYSQLD_BIN 可指定路径），
#       mysql 客户端，node（读 manifest），gzip。
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
[ -f "$MANIFEST" ] || { echo "[verify] 错误：缺少 manifest $MANIFEST（备份产物不完整）" >&2; exit 1; }

MYSQL_BIN=${MYSQL_BIN:-mysql}
MYSQLD_BIN=${MYSQLD_BIN:-$(command -v mysqld || true)}
[ -n "$MYSQLD_BIN" ] || { echo "[verify] 错误：找不到 mysqld（可设 MYSQLD_BIN 指定路径）" >&2; exit 1; }

TMPDIR_V=$(mktemp -d /tmp/cloudissue-verify.XXXXXX)
DATADIR="$TMPDIR_V/data"
SOCK="$TMPDIR_V/mysql.sock"
PORT_V=${VERIFY_PORT:-33077}
mkdir -p "$DATADIR"
PASS=0
FAIL=0

check() { # check <名称> <条件命令...>
  name=$1; shift
  if "$@" >/dev/null 2>&1; then
    echo "  PASS  $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $name"
    FAIL=$((FAIL + 1))
  fi
}

cleanup() {
  [ -n "${MYSQLD_PID:-}" ] && kill "$MYSQLD_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$TMPDIR_V"
}
trap cleanup EXIT

echo "[verify] 临时实例：datadir=$DATADIR port=$PORT_V"

# ---- 1) 初始化并启动临时实例（跳过 root 口令，仅监听 socket+回环） ----
"$MYSQLD_BIN" --initialize-insecure --datadir="$DATADIR" --basedir=$("$MYSQLD_BIN" --version | grep -o '\-\-basedir[= ][^ ]*' || true) >/dev/null 2>&1 || \
"$MYSQLD_BIN" --initialize-insecure --datadir="$DATADIR" >/dev/null 2>&1

"$MYSQLD_BIN" --datadir="$DATADIR" --socket="$SOCK" --port="$PORT_V" \
  --bind-address=127.0.0.1 --skip-networking=0 --mysqlx=0 \
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

# ---- 2) 建库 + 导入备份 ----
"$MYSQL_BIN" --socket="$SOCK" -uroot -e 'CREATE DATABASE issue_board CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;'
gzip -dc "$BACKUP_SQL" | "$MYSQL_BIN" --socket="$SOCK" -uroot issue_board
echo "[verify] 导入完成，开始校验"

MYSQL_Q="$MYSQL_BIN --socket=$SOCK -uroot -N -B issue_board"
MANIFEST_ABS=$(CDPATH= cd -- "$(dirname -- "$MANIFEST")" && pwd)/$(basename -- "$MANIFEST")

# ---- 3) 结构校验：核心表齐全 ----
EXPECTED_TABLES="issues users boards board_members issue_tags issue_status_logs issue_comments notifications board_meta"
for t in $EXPECTED_TABLES; do
  check "表存在：$t" sh -c "$MYSQL_Q -e \"SHOW TABLES LIKE '$t'\" | grep -q '^$t$'"
done

# ---- 4) 数据校验：行数与 manifest 一致 ----
for t in $EXPECTED_TABLES; do
  actual=$($MYSQL_Q -e "SELECT COUNT(*) FROM \`$t\`")
  expected=$(MANIFEST="$MANIFEST_ABS" node -e "const m=JSON.parse(require('fs').readFileSync(process.env.MANIFEST,'utf8')); process.stdout.write(String(m.tables['$t'] ?? 'MISSING'))")
  if [ "$expected" = "MISSING" ]; then
    echo "  FAIL  行数比对：$t（manifest 缺少该表）"
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
    echo "  FAIL  $name（样例：$orphan）"
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
