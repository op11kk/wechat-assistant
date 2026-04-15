# 微信公众号任务系统产品文档

## 1. 产品定位

本系统是一个基于微信公众号消息对话的任务分发与视频验收系统。

用户不需要先进入 H5 页面，而是在公众号里完成登记、接任务、确认协议、上传视频和查询状态。后端通过公众号消息推送接收用户消息，调用 AI 大模型解析用户意图，再由后端规则更新 Supabase 中的业务状态，并自动回复用户。

H5 页面可以保留为备用入口，例如大视频上传、复杂登记表单、后台人工处理等，但 MVP 的主流程以微信公众号对话为核心。

## 2. 产品目标

1. 用户进入公众号后，系统能自动区分已登记和未登记。
2. 未登记用户必须完成实名信息登记和协议同意，才可以开通任务权限。
3. 已登记用户可以通过公众号浏览任务、领取任务、上传视频和查看状态。
4. 每个任务需要保存任务类型、时长、报酬、截止时间、视频地址、合规同意和审核记录。
5. AI 负责理解用户自然语言和生成回复，核心业务状态由后端规则和 Supabase 数据决定。

## 3. 第一版不做什么

1. 不做完整自动打款。
2. 不让 AI 完全替代人工审核。
3. 不做完整后台管理系统。
4. 不强依赖 H5 页面。
5. 不让 AI 直接决定拉黑、付款、审核通过这类关键动作。

## 4. 用户角色

### 4.1 任务用户

通过微信公众号登记、接任务、上传视频，并在审核通过后获得任务报酬。

### 4.2 管理员

负责审核登记、审核视频、处理黑名单恢复、处理争议和特殊情况。

### 4.3 系统

负责接收微信消息、解析用户意图、读写 Supabase、下载微信视频素材、更新任务状态并自动回复用户。

## 5. 当前已有数据基础

当前已有三张表：

1. `participants`：登记用户表，通过 `wechat_openid` 识别用户。
2. `upload_sessions`：H5 分片上传会话表。
3. `video_submissions`：视频提交和审核表。

这三张表可以支撑视频收集，但还不能完整支撑任务系统。任务系统还需要任务表、接单表、协议表、黑名单表和事件日志表。

## 6. 推荐 MVP 数据模型

### 6.1 扩展 `participants`

建议新增字段：

```sql
alter table public.participants
add column if not exists has_required_headgear boolean not null default false,
add column if not exists fail_count integer not null default 0,
add column if not exists blacklisted_at timestamptz null;
```

建议扩展 `status`：

```text
pending_review
active
paused
withdrawn
blacklisted
```

状态含义：

1. `pending_review`：已提交登记，等待审核。
2. `active`：可以接任务。
3. `paused`：暂时不能接任务。
4. `withdrawn`：用户退出。
5. `blacklisted`：黑名单状态，需要人工恢复。

### 6.2 `tasks` 任务模板表

用于保存可发布的任务，例如做饭、洗碗、打扫卫生。

```sql
create table public.tasks (
  id bigserial primary key,
  title text not null,
  category text not null,
  description text null,
  duration_hours numeric not null,
  reward_amount numeric not null,
  required_headgear boolean not null default false,
  headgear_purchase_url text null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tasks_status_chk check (status in ('active', 'paused', 'archived')),
  constraint tasks_duration_chk check (duration_hours > 0),
  constraint tasks_reward_chk check (reward_amount >= 0)
);
```

示例任务：

1. 做饭，1 小时，50 元。
2. 洗碗，1 小时，50 元。
3. 打扫卫生，2 小时，100 元。

### 6.3 `task_assignments` 接单表

用于保存哪个用户领取了哪个任务，以及任务开始时间、截止时间和最终状态。

```sql
create table public.task_assignments (
  id bigserial primary key,
  participant_id bigint not null references public.participants(id) on delete restrict,
  task_id bigint not null references public.tasks(id) on delete restrict,
  status text not null default 'accepted',
  started_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  submitted_at timestamptz null,
  approved_at timestamptz null,
  rejected_at timestamptz null,
  expired_at timestamptz null,
  retry_count integer not null default 0,
  fail_count integer not null default 0,
  reward_amount numeric not null,
  reject_reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task_assignments_status_chk check (
    status in ('accepted', 'in_progress', 'submitted', 'approved', 'rejected', 'expired', 'cancelled')
  ),
  constraint task_assignments_retry_count_chk check (retry_count >= 0),
  constraint task_assignments_fail_count_chk check (fail_count >= 0),
  constraint task_assignments_reward_chk check (reward_amount >= 0)
);
```

这张表是任务系统核心。比如 5 小时内必须完成、失败 3 次进入黑名单，都应该围绕这张表处理。

### 6.4 `agreements` 协议同意表

用于保存登记协议和视频商用授权同意记录。

```sql
create table public.agreements (
  id bigserial primary key,
  participant_id bigint not null references public.participants(id) on delete restrict,
  task_assignment_id bigint null references public.task_assignments(id) on delete set null,
  agreement_type text not null,
  statement_text text not null,
  statement_version text not null default 'v1',
  agreed boolean not null default true,
  agreed_at timestamptz not null default now(),
  source text not null default 'wechat',
  raw_message text null,
  created_at timestamptz not null default now(),
  constraint agreements_type_chk check (agreement_type in ('registration', 'video_commercial_use')),
  constraint agreements_source_chk check (source in ('wechat', 'admin', 'h5'))
);
```

推荐视频合规声明：

```text
我确认本次上传视频由本人完成拍摄或本人有权授权使用，视频内容真实、合法，不侵犯他人肖像权、隐私权、著作权或其他权益。我同意将该视频授权本公司用于任务审核、商业使用、客户交付、宣传展示及相关运营场景。
```

用户必须明确回复 `同意授权`，系统才写入同意记录。

### 6.5 扩展 `video_submissions`

建议新增字段：

```sql
alter table public.video_submissions
add column if not exists task_assignment_id bigint null references public.task_assignments(id) on delete set null,
add column if not exists compliance_agreed boolean not null default false,
add column if not exists compliance_statement text null,
add column if not exists compliance_agreed_at timestamptz null,
add column if not exists object_url text null;
```

这样视频可以和任务、合规声明、审核结果关联起来。

### 6.6 `blacklists` 黑名单表

用于保存拉黑原因和人工恢复记录。

```sql
create table public.blacklists (
  id bigserial primary key,
  participant_id bigint not null references public.participants(id) on delete restrict,
  wechat_openid text not null,
  reason text not null,
  fail_count_snapshot integer not null default 0,
  status text not null default 'active',
  lifted_reason text null,
  lifted_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint blacklists_status_chk check (status in ('active', 'lifted'))
);
```

第一版可以先做系统内黑名单，即只限制本系统接单，不一定调用微信官方黑名单接口。

### 6.7 `task_events` 事件日志表

用于保存关键状态变化，方便排查问题和人工核查。

```sql
create table public.task_events (
  id bigserial primary key,
  participant_id bigint null references public.participants(id) on delete set null,
  task_assignment_id bigint null references public.task_assignments(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

建议记录的事件：

1. 用户开始登记。
2. 用户同意协议。
3. 用户浏览任务。
4. 用户领取任务。
5. 系统检查头套失败。
6. 用户上传视频。
7. 视频审核通过。
8. 视频审核不通过。
9. 任务超时。
10. 用户进入黑名单。
11. 管理员恢复用户权限。

## 7. 公众号对话流程

### 7.1 用户进入

触发方式：

1. 用户关注公众号。
2. 用户发送文字消息。
3. 用户发送视频或小视频。

系统处理：

1. 从微信消息中拿到 `openid`。
2. 通过 `wechat_openid` 查询 `participants`。
3. 查不到用户，进入未登记流程。
4. 查到用户但状态不是 `active`，根据状态回复对应提示。
5. 查到用户且状态为 `active`，进入任务流程。

### 7.2 未登记流程

流程：

1. 用户发送任意消息。
2. 系统回复：当前未登记，请回复 `登记` 开始申请。
3. 用户回复 `登记`。
4. 系统通过对话收集姓名、手机号等实名信息。
5. 系统发送登记协议。
6. 用户必须明确回复 `同意`。
7. 系统创建或更新 `participants`。
8. 用户状态进入 `pending_review` 或 `active`。
9. 如启用人工审核，则管理员审核后变成 `active`。

MVP 建议：

先使用 `pending_review`，不要让未审核用户直接接任务。

### 7.3 已登记任务流程

流程：

1. 用户回复 `任务`、`接单` 或类似表达。
2. AI 将意图解析为 `browse_tasks` 或 `claim_task`。
3. 后端查询可用任务。
4. 系统回复任务列表。
5. 用户选择任务。
6. 后端检查：
   - 用户状态是否为 `active`
   - 用户是否在黑名单
   - 任务是否需要头套
   - 用户是否具备头套
7. 如果没有头套，系统返回购买链接。
8. 如果检查通过，系统创建 `task_assignments`。
9. 系统回复任务要求、截止时间、报酬和视频提交说明。

### 7.4 视频提交流程

流程：

1. 用户通过公众号发送视频。
2. 后端收到 `MsgType=video` 或 `MsgType=shortvideo`。
3. 后端查找该用户最近一个进行中的任务。
4. 如果没有进行中的任务，回复：请先领取任务。
5. 如果该任务还没有视频商用授权同意，要求用户回复 `同意授权`。
6. 用户同意后，系统保存：
   - `wechat_media_id`
   - `task_assignment_id`
   - 合规声明字段
   - `review_status = pending`
7. 后端下载微信临时素材到 R2/COS。
8. 任务状态变成 `submitted`。
9. 系统回复：视频已收到，等待审核。

### 7.5 审核流程

审核通过：

1. `video_submissions.review_status = approved`
2. `task_assignments.status = approved`
3. 写入 `approved_at`
4. 回复用户：任务审核通过，报酬将进入结算流程。

审核不通过：

1. `video_submissions.review_status = rejected`
2. `task_assignments.status = rejected`
3. `retry_count + 1`
4. 回复用户不通过原因，并要求重新上传。

### 7.6 超时和黑名单流程

流程：

1. 定时任务扫描：
   - `status in ('accepted', 'in_progress')`
   - `deadline_at < now()`
2. 将接单记录改为 `expired`。
3. `participants.fail_count + 1`。
4. 如果 `fail_count >= 3`：
   - `participants.status = blacklisted`
   - `participants.blacklisted_at = now()`
   - 写入 `blacklists`
5. 用户下次互动时，系统提示当前账号已限制接单，需要人工核查恢复。

## 8. AI 意图设计

AI 只输出结构化意图，不直接决定业务动作。

推荐结构：

```json
{
  "intent": "register | browse_tasks | claim_task | agree_registration | agree_video_use | upload_video | ask_status | ask_help | unknown",
  "task_hint": "string or null",
  "real_name": "string or null",
  "phone": "string or null",
  "confidence": 0.0
}
```

规则：

1. 置信度低时，系统追问用户。
2. AI 不直接审核通过任务。
3. AI 不直接拉黑用户。
4. AI 不创建付款记录。
5. 所有状态变化必须由后端规则校验。

## 9. 后端状态机

### 9.1 用户状态

```text
pending_review -> active
active -> paused
active -> blacklisted
paused -> active
blacklisted -> active，只能人工恢复
active -> withdrawn
```

### 9.2 任务状态

```text
accepted -> in_progress
in_progress -> submitted
submitted -> approved
submitted -> rejected
rejected -> submitted
accepted/in_progress -> expired
accepted/in_progress -> cancelled
```

## 10. 接口和代码改造方向

### 10.1 `/api/wechat`

当前能力：

1. 公众号 URL 校验。
2. 接收微信 POST XML。
3. 解析文本、事件、视频、小视频。
4. 将聊天视频写入 `video_submissions`。

MVP 改造：

1. 增加按 `openid` 的用户状态判断。
2. 增加文本消息意图解析。
3. 增加未登记和已登记分支。
4. 增加任务浏览和接单。
5. 视频提交绑定 `task_assignment_id`。
6. 视频提交前要求合规授权。

### 10.2 新增定时任务接口

建议路由：

```text
GET /api/jobs/expire-assignments
```

作用：

1. 扫描超时任务。
2. 增加失败次数。
3. 累计 3 次后进入黑名单。

该接口需要用 `CRON_SECRET` 保护。

## 11. MVP 验收标准

1. 未登记用户能收到登记引导。
2. 已登记用户能请求任务列表。
3. 没有规定头套的用户能收到购买链接。
4. 具备头套的用户能领取任务。
5. 领取任务后写入 `started_at` 和 `deadline_at`。
6. 用户上传视频后能生成绑定任务的 `video_submissions`。
7. 视频提交能保存合规同意记录。
8. 审核不通过后允许重新上传。
9. 超时任务能增加失败次数。
10. 失败累计 3 次后用户进入黑名单。

## 12. 3 小时工作流程

这 3 小时目标是完成产品和技术方案落地，不是完整实现全部功能。

### 0:00-0:20 确认产品范围

产出：

1. 确认第一版只做公众号对话主流程。
2. 确认任务样例：
   - 做饭，1 小时，50 元。
   - 洗碗，1 小时，50 元。
   - 打扫卫生，2 小时，100 元。
3. 确认登记后是否需要人工审核。
4. 确认头套检查方式：先用 `has_required_headgear` 字段判断。
5. 确认黑名单规则：失败 3 次限制接单。

### 0:20-0:50 设计 Supabase 表结构

产出：

1. 编写新增表 SQL：
   - `tasks`
   - `task_assignments`
   - `agreements`
   - `blacklists`
   - `task_events`
2. 编写原表扩展 SQL：
   - `participants`
   - `video_submissions`
3. 补充必要索引：
   - 可用任务查询
   - 用户当前任务查询
   - 待审核视频查询
   - 超时任务扫描

本阶段不做付款表，避免范围过大。

### 0:50-1:30 设计公众号消息状态机

产出：

1. 定义固定指令：
   - `登记`
   - `同意`
   - `任务`
   - `接单`
   - `同意授权`
   - `状态`
   - `人工`
2. 定义后端判断树：
   - 查不到用户
   - 用户待审核
   - 用户可接单
   - 用户暂停
   - 用户黑名单
3. 定义未知消息兜底回复。
4. 定义 AI 意图 JSON。

### 1:30-2:10 确认后端原型范围

产出：

1. `/api/wechat` 改造清单。
2. 需要新增的 helper：
   - 按 openid 查用户
   - 查询可用任务
   - 创建接单记录
   - 查询当前进行中任务
   - 写入协议同意
   - 视频绑定任务
3. 第一版先用规则匹配，AI 作为第二层：

```text
先匹配明确指令。
如果没有命中指令，再调用 AI 解析意图。
如果 AI 置信度低，要求用户按固定指令回复。
```

### 2:10-2:40 设计超时和黑名单逻辑

产出：

1. 设计 `GET /api/jobs/expire-assignments`。
2. 定义超时查询条件：
   - `status in ('accepted', 'in_progress')`
   - `deadline_at < now()`
3. 定义处理逻辑：
   - 接单记录变成 `expired`
   - 用户 `fail_count + 1`
   - 满 3 次变成 `blacklisted`
4. 每次状态变化写入 `task_events`。

### 2:40-3:00 风险复盘和下一步清单

产出：

1. 复盘边界情况：
   - 用户未接任务直接传视频。
   - 用户有多个进行中任务。
   - 用户未同意授权就传视频。
   - 微信视频素材下载失败。
   - 微信重复推送同一个 `media_id`。
   - 审核不通过后重新上传。
2. 整理下一步开发顺序：
   - 数据库迁移。
   - 种子任务数据。
   - 公众号指令处理。
   - 接单创建。
   - 视频绑定任务。
   - 合规授权记录。
   - 超时任务扫描。
   - AI 意图识别接入。

## 13. 建议实现顺序

1. 先加数据库表。
2. 插入 3 条示例任务。
3. 在 `/api/wechat` 里加规则指令处理。
4. 实现任务列表和接单。
5. 将微信视频提交绑定到当前任务。
6. 增加合规授权记录。
7. 增加超时扫描任务。
8. 最后接 AI 意图识别。

## 14. 核心产品判断

这个产品应该是：

```text
公众号对话优先，数据库状态驱动，AI 辅助理解，人工兜底审核。
```

AI 可以让对话更自然，但 Supabase 中的状态和后端规则必须是唯一可信来源。
