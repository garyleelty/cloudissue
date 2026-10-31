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

## 复用要点（下轮开局先看这里）

- 待办清单在 `OPTIMIZATION.md`，已完成项会移到「已完成」区并附关键决策；
  下轮直接从「待办（按优先级）」挑。剩余：P3 乐观并发控制 / P3 批量操作 /
  P3 触屏拖拽 / P4 减小 payload / P4 前端类型化。
- 开局先确认 MySQL：本轮 `/tmp` 实例仍在跑（`mysqladmin --socket=/tmp/mysql.sock -uroot ping`）。
- **5173 端口常被上一轮遗留的 dev server 占着**，起服务前先：
  `pkill -f "node server/index.js"` 再 `pkill -f "mcp-server/index.js"`。
  注意 `pkill -f "server/index.js"` 会连带匹配到 `mcp-server/index.js`。
- `npm test` 依赖库里恰好 10 条数据（测试会断言总数回到 10），跑之前若被污染要清库重播种。
- 每步 `node --check public/src/*.js` 再跑三套测试；改动 UI 时序/debounce 时注意
  ui-smoke 第 10、11 组用了 `wait(200)`。
