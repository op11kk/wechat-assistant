# 数据规范（视频收集 · 方案 B）

## 1. 用户（participant）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID / 自增 | 内部主键 |
| wechat_openid | string | 微信用户标识（服务号内唯一） |
| display_name | string | 可选，对话中提取的称呼 |
| real_name | string | 实名（结算） |
| phone | string | 联系电话 |
| participant_code | string | 专属编号，如 6 位数字，唯一 |
| status | enum | active / paused / withdrawn 等 |
| extra | jsonb | 可扩展字段（收款方式等），遵循最小必要 |
| created_at / updated_at | timestamptz | 审计 |

## 2. 视频提交（video_submission）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID / 自增 | 内部主键 |
| participant_id | fk | 关联用户 |
| participant_code | string | 冗余便于工单查询 |
| source | enum | `chat`（对话框 media） / `h5` |
| wechat_media_id | string | 可选，微信侧临时素材 id |
| object_key / url | string | 对象存储路径或内网可解析地址 |
| file_name | string | 原始文件名（H5） |
| size_bytes | bigint | |
| mime | string | 如 video/mp4 |
| duration_sec | numeric | 若有探测 |
| user_comment | string | 用户备注「编号+视频序号」等 |
| review_status | enum | pending / approved / rejected |
| reject_reason | text | 驳回原因 |
| reviewed_at | timestamptz | |
| created_at | timestamptz | 收到时间 |

## 3. 对话与任务（可选）

| 表 | 用途 |
|----|------|
| conversation_state | 记录用户在流程中的当前步骤（登记中/已配号等），便于多轮追问 |
| outbound_job | 定时提醒、模板消息发送队列与状态 |

## 4. 编号规则

- `participant_code` **全局唯一**；建议数字固定宽度，按序或按雪花策略生成，避免与业务语义冲突。
- 所有 **上传**（含 H5）必须能校验「编号 + openid（或令牌）」一致性，防串单。

## 5. 存储对象命名（建议）

`uploads/{participant_code}/{submission_id}_{original_stem}.mp4`

对象存储需 **病毒扫描/内容合规策略** 按公司规范单独配置；元数据以数据库为准。

**DDL**：仓库根目录 `schema_video_collector.sql` 与本文字段对齐，在 Supabase SQL Editor 中执行。
