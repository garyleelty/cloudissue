#!/bin/sh
# ---------------------------------------------------------------
# CloudIssue · 数据库备份
# ---------------------------------------------------------------
# mysqldump 导出 + 各表行数清单（manifest）+ 保留策略。
# manifest 是恢复验证的基准：restore-verify.sh 用它比对恢复后的行数。
#
# 用法（环境变量，或自动读取项目根 .env）：
#   DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
#   BACKUP_DIR     输出目录（默认 ./backups）
#   KEEP_BACKUPS   保留份数（默认 14，超出按时间清理）
#
# 退出码：0 成功；非 0 失败（dump 或 manifest 任一失败即失败）。
# ---------------------------------------------------------------
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(dirname -- "$SCRIPT_DIR")

# ---- 参数：显式环境变量优先，否则读 .env ----
if [ -f "$PROJECT_ROOT/.env" ]; then
  # 仅加载 DB_*/BACKUP_* 相关键，不覆盖已有环境变量
  eval "$(grep -E '^(DB_HOST|DB_PORT|DB_USER|DB_PASSWORD|DB_NAME|BACKUP_DIR|KEEP_BACKUPS)=' "$PROJECT_ROOT/.env" | sed 's/^/export /' | grep -v '^export [A-Z_]*=$' || true)"
fi
DB_HOST=${DB_HOST:-127.0.0.1}
DB_PORT=${DB_PORT:-3306}
DB_USER=${DB_USER:-issue}
DB_NAME=${DB_NAME:-issue_board}
BACKUP_DIR=${BACKUP_DIR:-"$PROJECT_ROOT/backups"}
KEEP_BACKUPS=${KEEP_BACKUPS:-14}

# 密码必须存在（.env 或环境变量）
if [ -z "${DB_PASSWORD:-}" ]; then
  echo "[backup] 错误：缺少 DB_PASSWORD（环境变量或 .env）" >&2
  exit 1
fi

MYSQLDUMP_BIN=${MYSQLDUMP_BIN:-mysqldump}
MYSQL_BIN=${MYSQL_BIN:-mysql}
TS=$(date +%Y%m%d-%H%M%S)
OUT_SQL="$BACKUP_DIR/cloudissue-$TS.sql.gz"
OUT_MANIFEST="$BACKUP_DIR/cloudissue-$TS.manifest.json"

mkdir -p "$BACKUP_DIR"

MYSQL_ARGS="-h$DB_HOST -P$DB_PORT -u$DB_USER"
if [ -n "$DB_PASSWORD" ]; then
  MYSQL_ARGS="$MYSQL_ARGS -p$DB_PASSWORD"
fi

echo "[backup] 目标 $DB_HOST:$DB_PORT/${DB_USER}@${DB_NAME}"

# ---- 1) 行数清单：dump 之前取，作为恢复验证的期望值 ----
TABLES="issues users boards board_members issue_tags issue_status_logs issue_comments notifications board_meta"
ROWS_JSON=$($MYSQL_BIN $MYSQL_ARGS -N -B -e "USE \`$DB_NAME\`; $(for t in $TABLES; do echo "SELECT '$t', COUNT(*) FROM \`$t\`;"; done)" 2>/dev/null) || {
  echo "[backup] 错误：无法连接数据库或读取行数" >&2
  exit 1
}

# node 生成合法 JSON（项目依赖 node，CI 与本机均有）
echo "$ROWS_JSON" | node -e '
const lines = [];
require("readline").createInterface({ input: process.stdin })
  .on("line", (l) => { const [t, n] = l.split("\t"); if (t) lines.push([t, Number(n)]); })
  .on("close", () => {
    const out = {
      database: process.env.DB_NAME || "issue_board",
      takenAt: new Date().toISOString(),
      tables: Object.fromEntries(lines),
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  });' > "$OUT_MANIFEST.tmp" 2>/dev/null || {
  echo "[backup] 错误：manifest 生成失败（需要 node）" >&2
  exit 1
}
mv "$OUT_MANIFEST.tmp" "$OUT_MANIFEST"

# ---- 2) mysqldump：单事务一致性快照 ----
$MYSQLDUMP_BIN $MYSQL_ARGS \
  --single-transaction \
  --routines --triggers --events \
  --set-gtid-purged=OFF \
  --no-tablespaces \
  --skip-masking-policies \
  --skip-add-drop-masking-policy \
  "$DB_NAME" | gzip -9 > "$OUT_SQL"

SQL_BYTES=$(wc -c < "$OUT_SQL" | tr -d ' ')
if [ "$SQL_BYTES" -lt 200 ]; then
  echo "[backup] 错误：dump 产物异常地小（$SQL_BYTES 字节）" >&2
  rm -f "$OUT_SQL" "$OUT_MANIFEST"
  exit 1
fi

# ---- 3) 保留策略：超出 KEEP_BACKUPS 的旧备份（含 manifest）按时间清理 ----
REMOVED=$(ls -1t "$BACKUP_DIR"/cloudissue-*.sql.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r f; do
  rm -f "$f" "${f%.sql.gz}.manifest.json"
  basename "$f"
done)

echo "[backup] 完成：${OUT_SQL}（$SQL_BYTES 字节）"
echo "[backup] 清单：$OUT_MANIFEST"
[ -n "$REMOVED" ] && echo "[backup] 清理旧备份：$REMOVED"
exit 0
