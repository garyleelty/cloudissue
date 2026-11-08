-- ============================================================
--  CloudIssue · 任务看板 数据库结构
--  MySQL 8.0+
--  说明：本文件可重复执行（幂等），不会清空已有数据。
-- ============================================================

CREATE DATABASE IF NOT EXISTS `issue_board`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE `issue_board`;

-- ------------------------------------------------------------
-- 1. 任务主表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `issues` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title`        VARCHAR(255)    NOT NULL                COMMENT '任务标题',
  `description`  TEXT            NULL                    COMMENT '任务描述',
  `priority`     ENUM('high','medium','low') NOT NULL DEFAULT 'medium' COMMENT '优先级：高/中/低',
  `assignee`     VARCHAR(64)     NOT NULL DEFAULT ''     COMMENT '负责人',
  `due_date`     DATE            NULL                    COMMENT '截止日期，可为空',
  `status`       ENUM('backlog','planning','in_progress','done','failed') NOT NULL DEFAULT 'backlog' COMMENT '状态：未规划/规划中/进行中/已完成/失败',
  `position`     INT             NOT NULL DEFAULT 0      COMMENT '同列内排序位，越小越靠前',
  `version`      INT UNSIGNED    NOT NULL DEFAULT 1      COMMENT '乐观锁版本号，每次更新 +1',
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间',
  PRIMARY KEY (`id`),
  KEY `idx_issues_status_pos` (`status`, `position`),
  KEY `idx_issues_updated` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='任务卡片';

-- 幂等补列：历史库缺 `version` 时自动补上。
-- MySQL 不支持 ADD COLUMN IF NOT EXISTS，因此用 information_schema 判断后
-- 走 PREPARE 执行；列已存在时执行空语句，重复运行无副作用。
SET @ci_ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'issues'
       AND COLUMN_NAME = 'version') = 0,
  'ALTER TABLE `issues` ADD COLUMN `version` INT UNSIGNED NOT NULL DEFAULT 1 COMMENT ''乐观锁版本号，每次更新 +1'' AFTER `position`',
  'DO 0'
);
PREPARE ci_stmt FROM @ci_ddl;
EXECUTE ci_stmt;
DEALLOCATE PREPARE ci_stmt;

-- 幂等补列：issue 类型（bug/feature/task/chore/docs）
SET @ci_ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'issues'
       AND COLUMN_NAME = 'type') = 0,
  'ALTER TABLE `issues` ADD COLUMN `type` ENUM(''bug'',''feature'',''task'',''chore'',''docs'') NOT NULL DEFAULT ''task'' COMMENT ''issue 类型'' AFTER `title`',
  'DO 0'
);
PREPARE ci_stmt FROM @ci_ddl;
EXECUTE ci_stmt;
DEALLOCATE PREPARE ci_stmt;

-- ------------------------------------------------------------
-- 1.2 看板表（多看板 workspace；任务归属某个看板）
--     首个看板固定为 id=1 的「默认看板」，issues.board_id 的默认值指向它
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `boards` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`        VARCHAR(64)     NOT NULL                COMMENT '看板名，唯一',
  `description` VARCHAR(255)    NOT NULL DEFAULT ''     COMMENT '看板说明',
  `position`    INT             NOT NULL DEFAULT 0      COMMENT '排序位，越小越靠前',
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_boards_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='看板';

-- 幂等种子：保证至少存在一个看板（历史库与新库都补上 id=1 的默认看板）
INSERT INTO `boards` (`name`, `description`, `position`)
SELECT '默认看板', '开箱即用的第一个看板', 0 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM `boards`);

-- 幂等补列：任务归属看板（历史任务全部归入默认看板）。
-- 必须在 boards 建表并写入默认行之后执行：外键校验需要 id=1 存在。
SET @ci_ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'issues'
       AND COLUMN_NAME = 'board_id') = 0,
  'ALTER TABLE `issues` ADD COLUMN `board_id` BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT ''归属看板 id'' AFTER `status`, ADD KEY `idx_issues_board_status_pos` (`board_id`, `status`, `position`), ADD CONSTRAINT `fk_issues_board` FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON DELETE CASCADE',
  'DO 0'
);
PREPARE ci_stmt FROM @ci_ddl;
EXECUTE ci_stmt;
DEALLOCATE PREPARE ci_stmt;

-- ------------------------------------------------------------
-- 1.5 用户表（认证身份；看板为共享模式，任务不挂归属）
--     token_version：密码修改时 +1，使所有旧 JWT 立即失效
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username`      VARCHAR(32)     NOT NULL                COMMENT '登录名，唯一',
  `display_name`  VARCHAR(64)     NOT NULL DEFAULT ''     COMMENT '展示名',
  `password_hash` VARCHAR(255)    NOT NULL                COMMENT 'bcrypt 哈希',
  `token_version` INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT 'JWT 吊销版本号',
  `api_token`     VARCHAR(64)     NULL                    COMMENT '个人 API Token（Bearer），供 AI/MCP 客户端使用',
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`),
  UNIQUE KEY `uk_users_api_token` (`api_token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户';

-- 幂等补列：历史库的 users 表缺 `api_token` 时自动补上（同 issues.version 的做法）
SET @ci_ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = 'api_token') = 0,
  'ALTER TABLE `users` ADD COLUMN `api_token` VARCHAR(64) NULL COMMENT ''个人 API Token（Bearer），供 AI/MCP 客户端使用'' AFTER `token_version`, ADD UNIQUE KEY `uk_users_api_token` (`api_token`)',
  'DO 0'
);
PREPARE ci_stmt FROM @ci_ddl;
EXECUTE ci_stmt;
DEALLOCATE PREPARE ci_stmt;

-- 幂等补列：负责人关联真实用户（可空；旧数据继续用 assignee 文本）。
-- 必须放在 users 表建表之后（外键引用 users.id）。
SET @ci_ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'issues'
       AND COLUMN_NAME = 'assignee_id') = 0,
  'ALTER TABLE `issues` ADD COLUMN `assignee_id` BIGINT UNSIGNED NULL COMMENT ''负责人用户 id'' AFTER `assignee`, ADD KEY `idx_issues_assignee` (`assignee_id`), ADD CONSTRAINT `fk_issues_assignee` FOREIGN KEY (`assignee_id`) REFERENCES `users`(`id`) ON DELETE SET NULL',
  'DO 0'
);
PREPARE ci_stmt FROM @ci_ddl;
EXECUTE ci_stmt;
DEALLOCATE PREPARE ci_stmt;

-- ------------------------------------------------------------
-- 1.6 看板成员与角色（权限护栏的唯一数据来源，人与 AI 同受约束）
--     owner：管理成员 / 删除看板；member：读写任务；viewer：只读
--     必须放在 users 表建表之后（外键引用 users.id）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `board_members` (
  `board_id`   BIGINT UNSIGNED NOT NULL,
  `user_id`    BIGINT UNSIGNED NOT NULL,
  `role`       ENUM('owner','member','viewer') NOT NULL DEFAULT 'member' COMMENT 'owner=管理成员/删板，member=读写，viewer=只读',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '加入时间',
  PRIMARY KEY (`board_id`, `user_id`),
  KEY `idx_bm_user` (`user_id`),
  CONSTRAINT `fk_bm_board` FOREIGN KEY (`board_id`) REFERENCES `boards` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_bm_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='看板成员与角色';

-- 幂等迁移：启用权限前已存在的「看板 × 用户」全部补为 owner。
-- 目的：老用户零破坏（原本大家共享所有看板，语义保持不变）；
-- 自本轮之后新建的看板走新语义（创建者 = owner，其余成员显式添加）。
INSERT INTO `board_members` (`board_id`, `user_id`, `role`)
SELECT b.id, u.id, 'owner'
  FROM `boards` b
  CROSS JOIN `users` u
 WHERE NOT EXISTS (
    SELECT 1 FROM `board_members` bm WHERE bm.board_id = b.id
 )
 ON DUPLICATE KEY UPDATE `role` = `role`;

-- ------------------------------------------------------------
-- 1.7 站内通知（状态流转/指派/评论时对看板成员产生；接收人=成员，排除操作者）
--     actor 存展示名快照（人/机器人一致），读态用 read_at（NULL=未读）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `notifications` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    BIGINT UNSIGNED NOT NULL COMMENT '接收人',
  `board_id`   BIGINT UNSIGNED NOT NULL,
  `issue_id`   BIGINT UNSIGNED NOT NULL,
  `type`       ENUM('status','assignee','comment') NOT NULL COMMENT '通知类型',
  `title`      VARCHAR(255)    NOT NULL COMMENT '快照文案（含 #编号/标题/动作）',
  `actor`      VARCHAR(64)     NOT NULL DEFAULT '' COMMENT '操作者展示名快照（人/AI 一致）',
  `read_at`    DATETIME        NULL COMMENT '已读时间；NULL=未读',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '产生时间',
  PRIMARY KEY (`id`),
  KEY `idx_notif_user` (`user_id`, `read_at`, `id`),
  KEY `idx_notif_issue` (`issue_id`),
  CONSTRAINT `fk_notif_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_notif_board` FOREIGN KEY (`board_id`) REFERENCES `boards` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_notif_issue` FOREIGN KEY (`issue_id`) REFERENCES `issues` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='站内通知';

-- ------------------------------------------------------------
-- 1.8 Webhook 订阅（看板级外发通知；generic / 钉钉 / 企微 / 飞书）
--     事件流：站内通知落表 → HTTP 分发器消费外发（人与 AI 的动作同源）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `webhooks` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `board_id`   BIGINT UNSIGNED NOT NULL,
  `url`        VARCHAR(512)    NOT NULL COMMENT 'Webhook 端点（http/https）',
  `type`       ENUM('generic','dingtalk','wecom','feishu') NOT NULL DEFAULT 'generic' COMMENT '载荷格式',
  `secret`     VARCHAR(128)    NOT NULL DEFAULT '' COMMENT '签名密钥（generic=HMAC 头；dingtalk=加签）',
  `events`     VARCHAR(64)     NOT NULL DEFAULT 'status,assignee,comment' COMMENT '订阅事件，逗号分隔',
  `enabled`    TINYINT(1)      NOT NULL DEFAULT 1,
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wh_board` (`board_id`, `enabled`),
  UNIQUE KEY `uk_wh_board_url` (`board_id`, `url`),
  CONSTRAINT `fk_wh_board` FOREIGN KEY (`board_id`) REFERENCES `boards` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='看板 Webhook 订阅';

-- ------------------------------------------------------------
-- 1.9 Webhook 分发记录（每个通知 × 每个 webhook 的投递状态；失败重试）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `webhook_dispatch` (
  `notification_id` BIGINT UNSIGNED NOT NULL,
  `webhook_id`      BIGINT UNSIGNED NOT NULL,
  `ok`              TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '最近一次投递是否成功',
  `attempts`        INT             NOT NULL DEFAULT 0 COMMENT '累计尝试次数，>5 不再重试',
  `last_error`      VARCHAR(255)    NOT NULL DEFAULT '',
  `dispatched_at`   DATETIME        NULL COMMENT '成功投递时间；NULL=待投递/待重试',
  PRIMARY KEY (`notification_id`, `webhook_id`),
  KEY `idx_wd_pending` (`dispatched_at`, `attempts`),
  CONSTRAINT `fk_wd_notif` FOREIGN KEY (`notification_id`) REFERENCES `notifications` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wd_webhook` FOREIGN KEY (`webhook_id`) REFERENCES `webhooks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Webhook 分发记录';

-- ------------------------------------------------------------
-- 2. 标签表（一个任务可有多个标签）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `issue_tags` (
  `issue_id` BIGINT UNSIGNED NOT NULL,
  `tag`      VARCHAR(48)     NOT NULL COMMENT '标签名',
  PRIMARY KEY (`issue_id`, `tag`),
  KEY `idx_tags_tag` (`tag`),
  CONSTRAINT `fk_issue_tags_issue`
    FOREIGN KEY (`issue_id`) REFERENCES `issues` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='任务标签';

-- ------------------------------------------------------------
-- 3. 状态变更记录表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `issue_status_logs` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `issue_id`    BIGINT UNSIGNED NOT NULL,
  `from_status` VARCHAR(16)     NOT NULL DEFAULT '' COMMENT '原状态；空字符串表示新建',
  `to_status`   VARCHAR(16)     NOT NULL            COMMENT '新状态',
  `reason`      TEXT            NULL                COMMENT '失败原因，仅当 to_status=failed 时必填',
  `actor`       VARCHAR(64)     NOT NULL DEFAULT '' COMMENT '操作者（人=用户名，AI=客户端自报）；空表示系统或历史数据',
  `changed_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '变更时间',
  PRIMARY KEY (`id`),
  KEY `idx_logs_issue_time` (`issue_id`, `changed_at`),
  CONSTRAINT `fk_status_logs_issue`
    FOREIGN KEY (`issue_id`) REFERENCES `issues` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='状态变更记录';

-- 幂等补列：历史库的 issue_status_logs 缺 `actor` 时自动补上
SET @ci_ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'issue_status_logs'
       AND COLUMN_NAME = 'actor') = 0,
  'ALTER TABLE `issue_status_logs` ADD COLUMN `actor` VARCHAR(64) NOT NULL DEFAULT '''' COMMENT ''操作者（人=用户名，AI=客户端自报）；空表示系统或历史数据'' AFTER `reason`',
  'DO 0'
);
PREPARE ci_stmt FROM @ci_ddl;
EXECUTE ci_stmt;
DEALLOCATE PREPARE ci_stmt;

-- ------------------------------------------------------------
-- 3.5 评论表（issue 详情页的讨论；与状态变更记录分开，语义不同）
--     author_name 冗余存展示名：用户被删后评论仍可读
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `issue_comments` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `issue_id`    BIGINT UNSIGNED NOT NULL,
  `author_id`   BIGINT UNSIGNED NULL COMMENT '作者用户 id',
  `author_name` VARCHAR(64)     NOT NULL DEFAULT '' COMMENT '作者展示名（冗余，人/AI 均可）',
  `body`        TEXT            NOT NULL COMMENT '评论内容',
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '评论时间',
  PRIMARY KEY (`id`),
  KEY `idx_comments_issue_time` (`issue_id`, `created_at`),
  CONSTRAINT `fk_comments_issue`
    FOREIGN KEY (`issue_id`) REFERENCES `issues` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_comments_author`
    FOREIGN KEY (`author_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='issue 评论';

-- ------------------------------------------------------------
-- 4. 看板元数据（用于记录示例数据是否已初始化，避免重复覆盖）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `board_meta` (
  `meta_key`   VARCHAR(64)  NOT NULL,
  `meta_value` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`meta_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='看板元数据';
