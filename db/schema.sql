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
-- 4. 看板元数据（用于记录示例数据是否已初始化，避免重复覆盖）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `board_meta` (
  `meta_key`   VARCHAR(64)  NOT NULL,
  `meta_value` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`meta_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='看板元数据';
