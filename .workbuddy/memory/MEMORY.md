# CloudIssue · 项目长期记忆

## 项目定位

网页版任务看板（Issue Board），用于记录与跟踪任务状态。
固定五列：未规划 / 规划中 / 进行中 / 已完成 / 失败。

## 技术栈

- 前端：原生 HTML / CSS / ES Modules（零构建）
- 后端：Node 18+ / Express 4
- 数据层：MCP（@modelcontextprotocol/sdk）stdio 传输
- 数据库：MySQL 8，驱动 mysql2；参数校验用 Zod

## 架构铁律（改动时务必遵守）

1. **HTTP 层不许直连 MySQL**。`server/index.js` 不得 import mysql2，
   所有数据读写必须经 MCP Client 调用 `mcp-server` 的 tools。
2. **MCP Server 是唯一持有数据库连接池的组件**。
3. **前后端共用 `shared/constants.js`**，新增状态/优先级必须改这里，不要各写一份。
4. 失败原因校验必须在**服务端**（MCP tool 内）保留一份，不能只靠前端。

## 关键约定

- 移动接口传 `afterId`（插到哪张卡之后），**不要改成 index** —— 筛选状态下索引会错位。
- `position` 由服务端在事务内重排为连续整数，前端不要自行计算写入。
- 示例数据仅当 `issues` 表为空时写入，由 `board_meta.seeded_at` 兜底，
  任何"初始化"逻辑都不得覆盖已有用户数据。
- 标签既接受数组也接受逗号/空格分隔字符串，统一走 `normalizeTags()`（trim/截断 48/去重/去空）。

## 测试

```bash
npm run test:mcp   # MCP 传输 + 工具注册冒烟
npm test           # 端到端集成测试（32 项断言），需先启动服务
```

## 环境坑（已踩过）

- Docker Hub 不可达 → `docker compose up` 会失败，别再试。
- Homebrew 被沙箱挡住 → `brew install` 装不了 MySQL。
- 可行方案：`curl` 走 `127.0.0.1:51425` 代理下载 MySQL 官方 tarball 解压运行。
