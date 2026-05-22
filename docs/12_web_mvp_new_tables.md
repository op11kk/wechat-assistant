# Web 三端新表方案

## 目标

新 Web 三端不再继续写入旧微信/openid 表。旧表继续保留历史数据，新 Web 端从本机验证开始使用独立的 `web_mvp.web_*` 表，跑通后再把同一份 SQL 应用到腾讯云 PostgreSQL。

## 新表脚本

- `schema_web_mvp.sql`

这个脚本只新增 `web_mvp` schema 和 `web_mvp.web_*` 表，不会删除、修改或外键引用旧表。

核心表：

- `web_users`：Web 登录账号，角色为 `admin`、`leader`、`collector`
- `web_user_sessions`：Web 登录会话
- `web_phone_verification_codes`：手机号验证码预留
- `web_teams`：团长团队和团长码，`team_code` 就是新 Web 端的团长码
- `web_collectors`：Web 采集员档案，独立于旧 `participants`
- `web_team_bind_logs`：采集员绑定/换绑团长码日志
- `web_upload_sessions`：Web/H5 分片上传会话
- `web_video_submissions`：Web 端视频提交、人工审核、AI 预审状态
- `web_video_submission_artifacts`：预处理产物，例如 contact sheet
- `web_video_analysis_jobs`：可选 AI 分析任务队列
- `web_admin_audit_logs`：管理端操作日志

## 本机验证顺序

1. 本机 PostgreSQL 创建一个测试库，或者在当前库里创建 `web_mvp` schema。
2. `.env.local` 的 `DATABASE_URL` 指向本机 PostgreSQL。
3. `.env.local` 设置 `WEB_MVP_SCHEMA=web_mvp`。
4. 执行 `schema_web_mvp.sql`，新表会创建在 `web_mvp` schema 下。
5. 把代码里的数据访问从旧表逐步切到 `web_mvp.web_*` 表。
6. 跑通注册/登录、团长码绑定、上传、团长看团队、管理端审核、worker 处理。

如果建表账号和 `.env.local` 里的应用账号不是同一个，需要在 DataGrip 用建表账号执行授权，例如：

```sql
grant usage on schema web_mvp to wechat_app;
grant select, insert, update, delete on all tables in schema web_mvp to wechat_app;
grant usage, select, update on all sequences in schema web_mvp to wechat_app;
alter default privileges in schema web_mvp grant select, insert, update, delete on tables to wechat_app;
alter default privileges in schema web_mvp grant usage, select, update on sequences to wechat_app;
```

## 上线顺序

1. 先备份腾讯云 PostgreSQL。
2. 在腾讯云库执行 `schema_web_mvp.sql`，只新增表。
3. 部署已切换到 `web_*` 表的代码。
4. 观察新 Web 端数据是否正常写入。
5. 旧微信表继续保留为历史归档。

## 代码切换边界

第一阶段只做新 Web 三端，不迁移旧数据：

- 采集员端查 `web_mvp.web_collectors`
- 团长端查 `web_mvp.web_teams` + `web_mvp.web_collectors` + `web_mvp.web_video_submissions`
- 管理端查 `web_mvp.web_*`
- 上传链路写 `web_mvp.web_upload_sessions` 和 `web_mvp.web_video_submissions`
- worker 处理 `web_mvp.web_video_submissions`

旧微信公众号接口如果还要保留，可以继续读写旧表，两套链路互不影响。
