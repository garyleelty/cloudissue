# CloudIssue 迭代优化 · 自动化执行记忆

## 第 1 轮（2026-10-31）

**状态**：完成，三套测试全绿，工作区干净。

**本轮实施**（从 OPTIMIZATION.md 待办挑了风险最低、收益最高的两项，均为纯前端）：

1. `8f238d7` feat(web): 拖拽落位乐观更新，失败快照回滚 —— P2
2. `0e373a9` feat(web): 跨标签页同步（storage 事件 + 可见性兜底）—— P4
3. `1edb197` chore: 记忆笔记
4. `02f759d` docs: README 同步新特性

**测试结果**：test:mcp 通过 / npm test 32 项 / test:ui 38 项（原 26 项，新增第 10、11 组共 12 项断言）。

**架构铁律**：未触碰。本轮零数据层改动，`server/` 仍无 mysql2 引用。

## 第 2 轮（2026-11-01）

**状态**：完成，三套测试全绿，工作区干净。

**本轮实施**（挑了 P3 乐观并发控制 + P3 触屏拖拽，一前端一数据层）：

1. `3576083` feat: 乐观并发控制（version 列 + 冲突检测）
2. `722610a` feat(web): 触屏拖拽（Pointer Events 长按激活）
3. `030f093` docs: 同步两份文档与测试项数

**测试结果**：test:mcp 通过 / npm test 41 项（新增第 11 组 9 项）/ test:ui 51 项（新增第 12、13 组共 13 项）。

**架构铁律**：未破坏。version 校验在 MCP tool 内，HTTP 层只把 conflict 翻成 409。

**手工验证**：创建 → 失败原因闸门 400 → 填原因移动(version+1) → 过期版本 409 → 编辑 → 删除 → 总数回到 10。

## 复用要点（下轮开局先看这里）

- 待办清单在 `OPTIMIZATION.md`，已完成项会移到「已完成」区并附关键决策；
  下轮直接从「待办（按优先级）」挑。剩余：P3 批量操作 / P4 减小 payload / P4 前端类型化。
  （「减小 payload」的现状已在清单里更新：move 本身已很小，大头是落位后的全量 issue_list 回拉。）
- 开局先确认 MySQL：两轮下来 `/tmp` 实例都还在（`mysqladmin --socket=/tmp/mysql.sock -uroot ping`），
  但 /tmp 重启后会清，不可达就按任务描述里的 tarball 步骤重部署。
- **5173 端口常被上一轮遗留的 dev server 占着**，起服务前先：
  `pkill -f "node server/index.js"` 再 `pkill -f "mcp-server/index.js"`。
  注意 `pkill -f "server/index.js"` 会连带匹配到 `mcp-server/index.js`。
- `npm test` 依赖库里恰好 10 条数据（测试会断言总数回到 10），跑之前若被污染要清库重播种。
- 每步 `node --check public/src/*.js` 再跑三套测试。
- 改 schema 记得同步两处：CREATE TABLE + 幂等补列迁移（MySQL 无 ADD COLUMN IF NOT EXISTS）。
- Node / jsdom 缺 rAF、elementFromPoint、scrollBy，dnd.js 已有兜底，别直接改用原生 API。
