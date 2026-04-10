# 后端与接口说明（视频收集 · 方案 B）

本文与仓库实现一致：**Next.js App Router + TypeScript**，并通过 `GET /openapi.json` 暴露契约。**建表**：根目录 **`schema_video_collector.sql`**（`participants` / `video_submissions`）。

---

## 1. 微信开放平台（平台侧，非自有 HTTP 形态）

| 能力 | 用途 |
|------|------|
| 服务器配置校验 | GET 验证 `signature`；POST 接收加密/明文消息 |
| 接收消息 | 文本、事件（关注）、**视频/小视频** 等 |
| 被动回复 | 文本/图文等（注意时效与条数限制） |
| 获取临时素材 | 凭 `media_id` 下载用户上传视频 |
| 自定义菜单 | 配置「大视频上传」URL |

**安全**：Token、EncodingAESKey、AppSecret 仅存服务端与密钥管理，Never in 客户端。

---

## 2. 已实现 HTTP 路由（Next.js Route Handlers）

下列路径与 **`openapi.json`** 一致；未设 `API_SECRET` 时全部可匿名访问（生产务必配置）。**微信回调**不设 `API_SECRET` 校验。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/wechat/callback` | 公众平台 URL 校验，查询参数 `signature/timestamp/nonce/echostr`，需环境变量 **`WECHAT_TOKEN`** |
| POST | `/wechat/callback` | 接收明文 XML，返回 `success`。**MsgType 为 `video` / `shortvideo`** 且用户已登记时写入 `video_submissions`（先 `wechat/pending/{MediaId}`；若配置 **Cloudflare R2 + `WECHAT_APP_ID`/`WECHAT_APP_SECRET`**，服务端异步拉临时素材并写入 R2，再更新 `object_key` / `size_bytes` / `mime`） |
| POST | `/participants` |  body：`wechat_openid`, `real_name`, `phone`（可选 `status`, `extra`）→ 分配 **`participant_code`** |
| GET | `/participants/by_openid?wechat_openid=` | 按 openid 查询 |
| GET | `/participants/code/{participant_code}` | 按编号查询 |
| POST | `/upload/presign` | body：`participant_code`, `wechat_openid`, 可选 `content_type` → **Cloudflare R2 PUT 预签名**（返回 `url`、`object_key`、`expires_in`；详见 `openapi.json`） |
| POST | `/upload/complete` |  body：`participant_code`, `wechat_openid`, `source`(`chat`\|`h5`), `object_key` 等 → 写入 **`video_submissions`** |
| GET | `/admin/submissions` |  query：`review_status`, `limit` |
| PATCH | `/admin/submissions/{id}` |  body：`review_status`, `reject_reason`；`approved`/`rejected` 时自动写 **`reviewed_at`** |

### 2.1 定时任务（可选）

- 自建 cron / 队列：扫描待提醒用户，调用模板消息等（按微信类目与资质）。

---

## 3. 时间与时区

- 业务表统一 **`TIMESTAMPTZ`**（UTC 存库，展示按 Asia/Shanghai）。  
- 微信消息中的时间戳按官方文档换算。

---

## 4. 鉴权

- **管理端**：Bearer、内网 IP 限制、或企业 SSO。  
- **H5 预签名**：**短 TTL JWT / 一次性 nonce**，绑定 `openid` 或 `participant_id`。

---

## 5. 本地联调提示

- 微信要求公网 HTTPS，开发期可用 **内网穿透** 或 **云主机调试域名**。  
- 假消息可用 XML 样例 POST 到回调路由做单元测试（勿依赖线上微信）。
