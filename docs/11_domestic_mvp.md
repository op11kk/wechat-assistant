# 国内版 MVP 改造方案

## 目标

在保留现有 `H5 上传 + COS + AI 预审 + 人工终审` 基础能力的前提下，去掉公众号依赖，先做一套只面向中国大陆的三端最小可行方案：

- 采集员端：上传视频、看审核状态、看历史记录
- 团长端：看自己团队的采集员规模与上传进度
- 管理端：看全局数据、做人工审核、盯整体进度

## 本期范围

### 复用

- `app/h5` 上传页与分片上传接口
- COS 广州存储
- `video_submissions` / `upload_sessions` / 团长绑定数据
- 预处理 worker、OpenAI Batch、人工审核接口

### 暂不做

- 公众号菜单、微信消息流、微信通知
- 海外版部署与多区域数据隔离
- 完整登录权限体系
- 结算、收益、财务台

## 三端入口

- `/collector`
  - 当前直接复用 `/h5`
- `/leader`
  - 当前先展示团长团队聚合数据
- `/admin`
  - 当前先展示全局汇总与审核链路入口

## 技术决策

### 国内版技术栈

- 页面与业务 API：Next.js + TypeScript
- 长任务：Node.js Worker
- 数据库：PostgreSQL（腾讯云广州）
- 对象存储：COS（广州）
- 生产部署：腾讯云广州

### 为什么先不拆前后端

MVP 的核心是先把上传、审核、统计和三端入口跑通。当前项目已经有可复用的 Next.js 路由、数据库访问层和上传链路，继续在一个仓库里演进成本最低。

## 代码改造原则

1. 新功能优先加在“国内版入口页”上，不继续扩公众号流程。
2. 数据层允许先复用 `participants` 和 `team_leader_promoters`，但后续要逐步抽象为通用账号模型。
3. 原视频处理和审核链路尽量不动，只替换上游入口。
4. 团长端和管理端第一版先做“数据可见”，第二版再补权限隔离。

## 下一步建议

1. 增加国内版账号表与角色模型（collector / leader / admin）
2. 把 `/h5` 从“编号入口”切为“登录态入口”
3. 新增管理端真实页面，而不是只用 API
4. 团长端增加“仅看自己团队”的权限过滤

## 手机号注册建表

已新增建表文件：

- `schema_domestic_accounts.sql`

这份 SQL 会补齐：

- `app_users`
- `phone_verification_codes`
- `app_user_sessions`
- `participants.app_user_id`
- `team_leader_promoters.app_user_id`

这样后续可以按下面的关系接注册和三端权限：

- 管理员：`app_users.role = 'admin'`
- 团长：`app_users.role = 'leader'`，再绑定到 `team_leader_promoters`
- 采集员：`app_users.role = 'collector'`，再绑定到 `participants`

## 本期新增的注册登录能力

当前已补最小闭环：

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `/auth` 手机号注册/登录页

说明：

- 公开注册默认只创建 `collector`
- 注册成功后会自动创建 `participants` 记录
- 当前先采用“手机号 + 密码”的最小方案，不依赖短信平台
