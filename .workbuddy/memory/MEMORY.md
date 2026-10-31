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
- 拖拽是**乐观更新**的：落位先改本地 state，失败再用快照回滚 + 拉服务端兜底。
  改这条时注意：失败原因闸门必须在乐观更新**之前**，否则取消填原因卡片已经跑掉了。
- 跨标签页同步靠 localStorage 修订号（`sync.js`）+ storage 事件。
  修订号统一挂 `api.js` 的 `request()`（成功非 GET），不要在调用点各写一遍。

## 前端结构（已拆分，勿退回巨石文件）

`public/src/` 下按职责拆分为：
utils / toast / api / state / filters / dropdowns / render / dnd / modals / sync / main

- 数据流单向：`事件 → 改 state → notify() → renderBoard()`
- `dnd` 与 `modals` / `sync` 通过注入回调通信，避免循环依赖
- `state.issues` 的全局顺序**只在「同一 status 分组内」有意义**（render 逐列 filter），
  所以本地重排只需把卡片插到 afterId 之后，不必维护全局序号
- 取表单控件用 `form.elements.namedItem(name)`，别用 `form[name]`
  （后者依赖命名属性访问，jsdom 与各浏览器行为不一致）
- 卡片按 id 复用节点 + 数据签名，排序变化只做 DOM 移动
- 模块导入常量一律用相对路径 `../../shared/constants.js`，
  绝对路径 `/shared/...` 在 Node ESM 下无法解析

## 测试

```bash
npm run test:mcp   # MCP 传输 + 工具注册冒烟
npm test           # 端到端集成测试（32 项断言），需先启动服务 + MySQL
npm run test:ui    # UI 冒烟（jsdom，38 项），不需服务与数据库
```

> UI 冒烟里第 10 组（乐观更新/回滚）与第 11 组（跨标签页同步）用 `wait(200)` 等异步，
> 改动 debounce 或 reload 时序时要留意这里的等待时长。

> 三套都要跑。API 测试覆盖不到 UI 层——状态下拉为空的缺陷就是证据。

## 环境坑（已踩过）

- Docker Hub 不可达 → `docker compose up` 会失败，别再试。
- Homebrew 被沙箱挡住 → `brew install` 装不了 MySQL。
- 可行方案：`curl` 走 `127.0.0.1:51425` 代理下载 MySQL 官方 tarball 解压运行。
- 上一轮的 dev server 常驻占着 5173，新起服务会 `EADDRINUSE`。
  先 `pkill -f "node server/index.js"` 再 `pkill -f "mcp-server/index.js"`。
  注意 `pkill -f "server/index.js"` 会**连带匹配到 `mcp-server/index.js`**，要分开杀。
