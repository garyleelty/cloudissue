# CloudIssue · 网页版任务看板（Issue Board）

一个用于记录和跟踪任务状态的看板应用。固定五列（`未规划 / 规划中 / 进行中 / 已完成 / 失败`），卡片支持**跨列拖拽**变更状态，进入「失败」列**必须先填写失败原因**，数据经 **MCP → MySQL** 持久化，刷新页面不丢失。

---

## 一、功能特性

| 能力 | 说明 |
| --- | --- |
| 五列固定看板 | `未规划 → 规划中 → 进行中 → 已完成 / 失败` |
| 拖拽流转 | 支持跨列移动与列内排序；鼠标走原生拖拽，**移动端长按卡片即可拖拽** |
| 拖拽视觉反馈 | 目标列整体高亮（进入失败列时为红色高亮）+ 虚线占位块实时跟随 |
| 失败原因强校验 | 拖入「失败」列弹出原因弹窗；未填写则**拒绝移动**并给出明确提示 |
| 卡片字段 | 标题、描述、优先级（高/中/低）、负责人、标签（多值）、截止日期、创建时间 |
| 状态变更记录 | 每次状态变动自动追加「变更时间 + 原状态 + 新状态」；因失败变更时一并记录失败原因 |
| 增删改 | 新建 / 编辑 / 删除，删除需二次确认 |
| 批量操作 | 卡片复选框或列头全选后，可一次性**批量移动**到目标列或**批量删除**；移入「失败」列同样要求填写原因 |
| 乐观更新 | 拖拽落位后立即本地生效，不等服务端往返；请求失败自动回滚并重新拉取 |
| 跨标签页同步 | 同一浏览器多开时，一处改动其他标签页自动跟上；切回前台再兜底拉一次 |
| 并发保护 | 任务带 `version` 版本号，编辑/移动时携带；被他人抢先修改则返回 409 冲突提示，不静默覆盖 |
| 组合筛选 | 关键词（标题 & 描述）+ 优先级 + 标签 + 负责人，多条件 AND 组合，支持一键清空 |
| 列计数 | 每列顶部实时显示 `筛选后数量/总数`，如 `3/10` |
| 持久化 | MySQL 8，数据读写全部经 MCP；仅在数据表为空时初始化示例任务 |
| 设计风格 | Apple 设计语言：充足留白、大圆角、浅色系、分层细腻阴影、SF 字体栈 |
| 响应式 | 桌面端五列并排；移动端横向滚动（scroll-snap）+ 顶部列切换标签联动 |

---

## 二、技术栈

- **前端**：原生 HTML / CSS / ES Modules（零构建、零框架依赖）
- **后端**：Node.js 18+ / Express 4
- **数据层**：MCP（Model Context Protocol）`@modelcontextprotocol/sdk` v1.32
- **数据库**：MySQL 8（驱动 `mysql2`）
- **参数校验**：Zod

---

## 三、目录结构

```
cloudissue/
├── package.json                 # 依赖与启动脚本
├── .env.example                 # 环境变量模板
├── docker-compose.yml           # 一键启动 MySQL 8
├── db/
│   └── schema.sql               # 建表 DDL（幂等，可重复执行）
├── shared/
│   └── constants.js             # 前后端共用的枚举与文案
├── mcp-server/
│   ├── index.js                 # MCP Server：唯一访问 MySQL 的组件
│   └── db.js                    # 连接池 / 事务 / 建表执行
├── server/
│   └── index.js                 # Express：REST API + 静态资源（不直连 DB）
└── public/
    ├── index.html
    ├── styles.css
    └── src/                     # 按职责拆分的 ES 模块（见下）
```

`public/src/` 模块划分：`utils` / `toast` / `api` / `state` / `filters` /
`dropdowns` / `render` / `dnd` / `modals` / `sync` / `main`（入口）。

### 分层与职责边界

```
浏览器 (public/)
   │  fetch  /api/*
   ▼
Express HTTP 层 (server/index.js)      ← 只做路由与静态资源，持有 MCP Client
   │  MCP over stdio
   ▼
MCP 数据服务 (mcp-server/index.js)     ← 唯一持有 MySQL 连接池，暴露 7 个 tools
   │  mysql2
   ▼
MySQL 8 (issue_board)
```

> HTTP 层**没有任何** `mysql2` 引用。所有读写都必须经 MCP tools，这样数据访问口径唯一、可审计、可被任意 MCP 客户端复用。

---

## 四、启动方式

### 方式 A：Docker 启动 MySQL（推荐）

```bash
cd cloudissue

# 1) 安装依赖
npm install

# 2) 创建环境变量文件
cp .env.example .env

# 3) 启动 MySQL 8 容器（首次会自动拉取镜像）
npm run db:up

# 4) 启动应用
npm start
```

浏览器打开 **http://localhost:5173**

停止数据库：`npm run db:down`

### 方式 B：使用已有 MySQL

```bash
# 1) 建库 + 建表（幂等，可重复执行）
mysql -h 127.0.0.1 -u root -p < db/schema.sql

# 2) 配置连接信息
cp .env.example .env
#   编辑 .env，填入你的 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME

# 3) 安装依赖并启动
npm install
npm start
```

应用启动时会自动调用 MCP 的 `board_bootstrap` 完成建表与按需初始化，无需手动执行 `schema.sql`。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DB_HOST` | `127.0.0.1` | MySQL 主机 |
| `DB_PORT` | `3306` | MySQL 端口 |
| `DB_USER` | `root` | 用户名 |
| `DB_PASSWORD` | 空 | 密码 |
| `DB_NAME` | `issue_board` | 数据库名 |
| `PORT` | `5173` | HTTP 服务端口 |

### 现成本地 MySQL 实例（可选）

开发时已在 `/tmp` 解压并运行了一个 MySQL 8.4.5 实例，可直接用于验证，无需 Docker：

- basedir：`/tmp/mysql-8.4.5-macos15-arm64`
- datadir：`/tmp/mysqldata`
- socket：`/tmp/mysql.sock`
- 内置账号：`issue / issue_pass`（与 `.env.example` 默认值一致，另有免密 `root`）

启动 / 停止：

```bash
# 启动
/tmp/mysql-8.4.5-macos15-arm64/bin/mysqld \
  --basedir=/tmp/mysql-8.4.5-macos15-arm64 \
  --datadir=/tmp/mysqldata --port=3306 \
  --socket=/tmp/mysql.sock --pid-file=/tmp/mysqld.pid --mysqlx=0 &

# 停止
/tmp/mysql-8.4.5-macos15-arm64/bin/mysqladmin \
  --socket=/tmp/mysql.sock -uroot shutdown
```

> 该实例位于系统临时目录，机器重启后会被清理；正式使用请按方式 A 或方式 B 搭建。

### 单独调试 MCP 数据服务

```bash
npm run mcp
# 或使用官方 Inspector：
npx @modelcontextprotocol/inspector node mcp-server/index.js
```

---

## 五、基本使用流程

1. **首次启动**：任务表为空 → 自动写入 10 条示例任务，覆盖全部五列与三档优先级（其中「失败」列示例已带失败原因）。
2. **新建任务**：点击右上角「新建任务」，填写标题（必填）、描述、优先级、负责人、状态、截止日期、标签（逗号分隔）。
   - 若状态选择「失败」，表单会展开「失败原因」输入框，未填写将无法保存。
3. **拖拽流转**：桌面端按住卡片拖到目标列；**移动端长按卡片约 0.2 秒**后拖动。目标列高亮并显示虚线占位块；松手即完成移动。
   - 拖入「失败」列 → 弹出「标记为失败」弹窗 → 填写原因后确认移动；取消或留空则**拒绝移动**，并提示「已取消移动：未填写失败原因，任务保留在原列」。
4. **查看变更记录**：点击卡片底部「变更 N」展开时间线，显示每次变更的 `原状态 → 新状态`、时间，失败变更额外显示原因。
5. **筛选**：在筛选栏输入关键词，或在优先级 / 标签 / 负责人下拉中多选（同类 OR，跨类 AND）；列头计数实时变为 `筛选后/总数`；点「清空筛选」一键还原。
6. **编辑 / 删除**：卡片右下角的铅笔 / 垃圾桶图标；删除会弹出二次确认。
7. **刷新页面**：数据从 MySQL 重新加载，状态、标签与变更记录完整保留。

> **移动端**：长按卡片即可拖拽跨列，拖到屏幕边缘会自动横向滚动；列之间支持横向滑动并通过顶部标签联动定位。

---

## 六、数据结构设计

### 6.1 实体关系

```
┌──────────────────────┐
│       issues         │
│  (任务主表)           │
│  PK id               │
└──────────┬───────────┘
           │ 1 : N
           ├──────────────────────────┐
           ▼                          ▼
┌──────────────────────┐   ┌──────────────────────────┐
│     issue_tags       │   │   issue_status_logs      │
│  PK (issue_id, tag)  │   │  PK id                   │
│  FK issue_id         │   │  FK issue_id             │
└──────────────────────┘   └──────────────────────────┘
           │                          │
           └──── ON DELETE CASCADE ───┘

┌──────────────────────┐
│      board_meta      │  看板元数据（记录示例数据初始化状态）
│  PK meta_key         │
└──────────────────────┘
```

两张子表均通过外键 `ON DELETE CASCADE` 关联主表——删除任务时，标签与变更记录自动清理，不会出现孤儿数据。

### 6.2 `issues` · 任务主表

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `BIGINT UNSIGNED` | PK, AUTO_INCREMENT | 任务唯一标识 |
| `title` | `VARCHAR(255)` | NOT NULL | 任务标题 |
| `description` | `TEXT` | NULL | 任务描述 |
| `priority` | `ENUM('high','medium','low')` | NOT NULL, DEFAULT `medium` | 优先级：高 / 中 / 低。用 ENUM 约束，避免脏值 |
| `assignee` | `VARCHAR(64)` | NOT NULL, DEFAULT `''` | 负责人，空串表示未指派（前端显示为「未指派」） |
| `due_date` | `DATE` | NULL | 截止日期，可为空（表示无期限） |
| `status` | `ENUM('backlog','planning','in_progress','done','failed')` | NOT NULL, DEFAULT `backlog` | 状态列，五值固定 |
| `position` | `INT` | NOT NULL, DEFAULT `0` | **同列内的排序位**，越小越靠前；每次移动后由服务端重排为连续整数 |
| `version` | `INT UNSIGNED` | NOT NULL, DEFAULT `1` | **乐观锁版本号**，每次更新 +1；拖拽排序不波及其他卡片 |
| `created_at` | `DATETIME` | DEFAULT CURRENT_TIMESTAMP | 创建时间 |
| `updated_at` | `DATETIME` | DEFAULT CURRENT_TIMESTAMP ON UPDATE | 最后更新时间 |

**索引**：
- `idx_issues_status_pos (status, position)` —— 看板按列取卡片并按序渲染的主查询路径
- `idx_issues_updated (updated_at)` —— 按更新时间排序/筛选

### 6.3 `issue_tags` · 标签表

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `issue_id` | `BIGINT UNSIGNED` | 复合主键一部分，外键 → `issues.id` |
| `tag` | `VARCHAR(48)` | 复合主键一部分，标签名 |

- 复合主键 `(issue_id, tag)` 天然去重：同一任务不会重复打同一个标签。
- 独立索引 `idx_tags_tag` 支撑「按标签筛选」和标签选项聚合。
- 一个任务多个标签 = 多行，满足「标签（可多个）」要求。

### 6.4 `issue_status_logs` · 状态变更记录表

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `BIGINT UNSIGNED` | PK |
| `issue_id` | `BIGINT UNSIGNED` | 外键 → `issues.id` |
| `from_status` | `VARCHAR(16)` | 原状态；`''` 表示任务新建 |
| `to_status` | `VARCHAR(16)` | 新状态 |
| `reason` | `TEXT` | 失败原因，**仅当 `to_status='failed'` 时非空** |
| `changed_at` | `DATETIME` | 变更时间 |

- 设计上做成**追加式日志（append-only）**，只 INSERT 不 UPDATE，天然保留完整轨迹。
- `from_status` 用空串而非 NULL 表示「新建」，避免与真正的"无原状态"混淆，也简化前端渲染（`fromStatus ? label : '新建'`）。
- 索引 `idx_logs_issue_time (issue_id, changed_at)` 支撑按任务取时间线。

### 6.5 `board_meta` · 看板元数据

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `meta_key` | `VARCHAR(64)` | PK |
| `meta_value` | `VARCHAR(255)` | 值 |

当前仅用 `seeded_at` 记录示例数据初始化时间，配合**「表为空才写入」**的判断，双重保证不会覆盖用户数据。

---

## 七、关键字段说明

### `status` —— 状态列

| 枚举值 | 显示名 | 语义 |
| --- | --- | --- |
| `backlog` | 未规划 | 已记录但未排期 |
| `planning` | 规划中 | 正在评估方案 / 拆解 |
| `in_progress` | 进行中 | 正在执行 |
| `done` | 已完成 | 已交付 |
| `failed` | 失败 | 终止，**必须携带失败原因** |

前端列顺序即数组 `STATUSES` 顺序，定义在 `shared/constants.js`，前后端共用一份，避免文案漂移。

### `priority` —— 优先级

`high`（红） / `medium`（橙） / `low`（绿）。卡片左侧色条与右上角 chip 同时体现，扫视即可分辨。

### `position` —— 排序位

- 只在**同一列内**有意义；跨列移动时会重新编号。
- 服务端在事务内把目标列全部 id 取出 → 按目标位置插入 → 统一重排为 `0..n-1`。这样 position 永远是稠密连续整数，避免"插入中间没有整数可用"的问题。

### `version` —— 乐观锁版本号

- 每次编辑（含状态变更）后 +1；客户端把自己看到的版本通过 `expectedVersion` 带回服务端。
- 服务端在事务内 `SELECT ... FOR UPDATE` 后比对：不一致则返回 `conflict`，HTTP 层映射为 **409**，前端提示「任务已被其他人修改」并自动拉一次最新数据。
- **列内排序不 bump 其他卡片的 version** —— 重排只是位置变化，不该让整列的乐观锁集体失效；只有真正被移动的那张卡 +1。
- 参数可选：不传就退化为「后写覆盖」，老客户端与脚本不受影响。

### `afterId` —— 移动接口的关键参数

前端不传"索引"，而是传 **"插入到哪个卡片的后面"**。原因是：筛选生效时可见卡片只是子集，索引会在服务端错位；而"插入到某张具体卡片之后"在任何筛选状态下都语义唯一、可靠。

- `afterId = null` → 插到列首（或空列的第一个位置）
- `afterId = <id>` → 插到该卡片之后；找不到则追加到末尾

### `reason` —— 失败原因

- 只在 `to_status = 'failed'` 时写入，其他情况为 `NULL`。
- 校验在**服务端**完成（MCP tool `issue_move` / `issue_update` 内），前端拦截只是体验优化，绕过前端也无法写入非法数据。

---

## 八、REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查（经 MCP 探测数据库） |
| `GET` | `/api/issues` | 返回全部任务（含 `tags` 与 `logs`） |
| `POST` | `/api/issues` | 新建任务 |
| `PUT` | `/api/issues/:id` | 更新任务字段（含状态变更） |
| `POST` | `/api/issues/:id/move` | 移动 / 排序：`{ toStatus, afterId, failReason, expectedVersion? }`；版本冲突返回 **409** |
| `POST` | `/api/issues/batch/move` | 批量移动：`{ ids[], toStatus, failReason? }`，按勾选顺序追加到目标列尾部 |
| `POST` | `/api/issues/batch/delete` | 批量删除：`{ ids[] }` |
| `DELETE` | `/api/issues/:id` | 删除任务 |

> 批量接口不新增 MCP tool：服务端只是对同一批 id 循环调用既有的 `issue_move` / `issue_delete`，
> 校验（状态枚举、失败原因必填）依旧留在 MCP 内。两个路由注册在 `/api/issues/:id/move` 之前，
> 否则 `batch` 会被 `:id` 吃掉。

返回的任务对象示例：

```json
{
  "id": 5,
  "title": "MySQL 持久化与 MCP 数据层",
  "description": "建表、连接池封装，并把全部读写收敛到 MCP tools。",
  "priority": "high",
  "assignee": "周野",
  "tags": ["后端", "数据库", "MCP"],
  "dueDate": "2026-11-01",
  "status": "in_progress",
  "position": 0,
  "createdAt": "2026-10-16T09:12:03.000Z",
  "updatedAt": "2026-10-29T08:00:00.000Z",
  "logs": [
    { "id": 12, "fromStatus": "", "toStatus": "backlog", "reason": "", "changedAt": "2026-10-16T09:12:03.000Z" },
    { "id": 18, "fromStatus": "backlog", "toStatus": "in_progress", "reason": null, "changedAt": "2026-10-20T10:00:00.000Z" }
  ]
}
```

---

## 九、MCP Tools

| Tool | 入参 | 说明 |
| --- | --- | --- |
| `db_health` | — | 检查 MySQL 连接 |
| `board_bootstrap` | — | 执行建表；仅当任务表为空时写入示例任务 |
| `issue_list` | — | 返回全部任务（含标签与变更记录） |
| `issue_create` | `title, description, priority, assignee, tags, dueDate, status, failReason` | 新建 |
| `issue_update` | `id` + 待更新字段 + `expectedVersion?` | 更新（状态变更时写日志，版本冲突返回 `conflict`） |
| `issue_move` | `id, toStatus, afterId, failReason, expectedVersion?` | 移动 / 排序（进入失败列需原因） |
| `issue_delete` | `id` | 删除 |

---

## 十、实现要点与边界处理

1. **失败原因双重校验**：前端拖拽时弹窗拦截；MCP tool 服务端二次校验，任一环节缺失都会拒绝并提示。
2. **并发安全**：移动与更新均在事务内 `SELECT ... FOR UPDATE` 锁定目标行，再做排序重排，避免并发拖拽产生重复 position。
3. **标签归一化**：支持数组或逗号/空格分隔字符串；自动 `trim`、截断到 48 字符、去重、丢弃空值。
4. **示例数据只写一次**：`COUNT(*) = 0` 才写入；非空则原样保留用户数据，并在启动日志中说明。
5. **XSS 防护**：所有用户内容渲染前统一经过 `esc()` 转义。
6. **级联清理**：删除任务时通过外键级联清理标签与变更记录。
7. **日期语义**：`due_date` 为纯日期字符串 `YYYY-MM-DD`；`created_at` / `changed_at` 为 ISO 8601，前端统一格式化。
8. **乐观更新**：拖拽落位先改本地状态并立即重绘，再提交服务端；请求失败用快照回滚，并重新拉一次服务端数据兜底，避免出现「假成功」。失败原因闸门前置到乐观更新之前，取消填原因不会产生任何本地变化。
9. **跨标签页同步**：写库成功后往 `localStorage` 写一个修订号（挂在 `api.js` 的 `request()` 上，单一收口），其他标签页收到 `storage` 事件即刷新；连续变更做 80ms 合并。标签页切回前台时再兜底拉一次，覆盖后台事件被节流、以及其他端改动的情况。
10. **并发安全**：编辑与移动携带 `version`，服务端在事务内比对，冲突返回 409 而非覆盖；落位重排不动其他卡片的版本号。
11. **触屏拖拽**：HTML5 DnD 在触屏上不可用，因此按 `pointerType` 分流——触屏与触控笔走 Pointer Events，长按 220ms 激活，激活前的滑动一律让给页面滚动；靠近左右边缘自动横向滚动以便跨列，拖拽期间临时关闭 `scroll-snap`。落位后与鼠标走同一套 `performMove`。
12. **可访问性**：弹窗支持 `Esc` 关闭，交互元素带 `aria-*` 属性；`prefers-reduced-motion` 下关闭动效。
13. **批量操作**：勾选态放在 `state.selection`，卡片复选框与列头全选（部分勾选显示半选态）都能写它；底部批量条只在有勾选时出现。批量移动复用同一套失败原因闸门，删除复用同一个二次确认弹窗；清空筛选与重新拉取时会清理失效勾选，避免误伤被筛掉或已被删除的卡片。

---

## 十一、自检与验证

项目附带三个测试脚本：

```bash
npm run test:mcp   # MCP 链路冒烟：验证 stdio 传输正常、7 个 tools 全部注册（不需服务）
npm test           # 端到端集成测试：覆盖全链路与全部业务规则（57 项断言，需先起服务）
npm run test:ui    # UI 冒烟（jsdom，70 项断言，不需服务与数据库）
```

`npm run test:ui` 覆盖 `npm test` 够不到的那一层：骨架渲染、卡片复用、状态下拉填充、
筛选与列计数、失败原因闸门、乐观更新与回滚、跨标签页同步、冲突提示、触屏拖拽、批量选择与批量条。

`npm test` 覆盖的用例：

1. 健康检查经 MCP 返回数据库信息；
2. 首次启动写入 10 条示例任务，覆盖五列与三档优先级；
3. 新建任务：返回自增 ID、标签正确拆分、自动产生首条变更记录；
4. **未填写失败原因移动到「失败」列被拒绝，且卡片停留原列**；空白字符串同样被拒；
5. 填写原因后移动成功，变更记录完整写入「原状态 / 新状态 / 时间 / 失败原因」；
6. `afterId` 排序语义正确（A、B、C → 插到 A 后 → A、C、B）；
7. 更新任务：字段与标签整体替换、离开失败列产生新记录；
8. 编辑时改为「失败」但未填原因同样被拒；
9. 删除成功，且总数回到 10 —— 证明**数据未被重复初始化覆盖**；
10. 非法状态枚举被拒绝；
11. 乐观并发控制：列表返回版本号、版本一致时更新成功并 +1、版本过期时更新/移动返回 409、冲突不覆盖他人改动；
12. 批量操作：未选任务被拒、**批量移入「失败」列未填原因被拒且三张卡停留原列**、填写原因后成功、按勾选顺序追加到目标列尾部、变更记录写入批量原因、批量删除后总数回到 10、删除不存在的任务返回 400。

### 本次开发中的实测环境

- Node.js v22.22.2 / macOS (Apple Silicon)
- MySQL 8.4.5（官方 tarball 解压运行于 `/tmp`）
- MCP SDK v1.32.2

---

## 十二、常见问题

**Q：启动报 `数据库初始化失败`？**
检查 `.env` 中 MySQL 连接信息，并确认数据库可访问。若用 Docker，执行 `docker compose ps` 确认容器已 healthy（首次启动需等待约 20–30 秒）。

**Q：想彻底重置示例数据？**
```sql
DELETE FROM issue_tags;
DELETE FROM issue_status_logs;
DELETE FROM issues;
DELETE FROM board_meta WHERE meta_key = 'seeded_at';
```
重启应用即会重新初始化。

**Q：移动端怎么拖拽卡片？**
**长按卡片约 0.2 秒**即可进入拖拽，手指拖动到目标列松手；靠近屏幕左右边缘会自动横向滚动，方便跨列投放。
直接滑动仍然是页面滚动，不会误触发拖拽。HTML5 原生拖拽在触屏上不被支持，因此触屏走的是 Pointer Events 实现，
落位逻辑与桌面端完全一致（同样受失败原因校验约束）。
