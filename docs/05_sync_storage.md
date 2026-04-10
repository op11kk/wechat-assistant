# 媒体流转、存储与一致性（方案 B · Cloudflare R2）

## 1. 原则

- **微信侧**：消息 XML 中的 `MediaId` 须在临时素材有效期内，用 **`access_token`（`client_credential`，`WECHAT_APP_ID` + `WECHAT_APP_SECRET`）** 调用 **`cgi-bin/media/get`** 拉取二进制。
- **自有侧**：**Cloudflare R2** 为权威副本；数据库仅存 `object_key`、大小、MIME 等元数据。
- **H5 大文件**：浏览器对 R2 发起 **PUT**（`POST /upload/presign` 返回预签名 URL），成功后 **`POST /upload/complete`** 落库。

## 2. 对话框小视频路径

1. `POST /wechat/callback` 解析 `video` / `shortvideo`，写入 `video_submissions`（先占位 `object_key=wechat/pending/{MediaId}`）。
2. 若已配置 **Cloudflare R2 + `WECHAT_APP_ID`/`WECHAT_APP_SECRET`**：服务端会异步拉取微信临时素材并写入 R2，路径建议 `uploads/{participant_code}/chat/{submission_id}.mp4`（或按 Content-Type 使用 `.mov`），再 **UPDATE** 表字段 `object_key`、`size_bytes`、`mime`。
3. 未配置云/微信凭证时：保留占位 `object_key`，由运维补拉或仅依赖人工流程。

未登记 openid：不建单，仅日志。

## 3. 大视频路径（菜单 → H5 → R2）

1. H5 携带鉴权后调用 **`POST /upload/presign`**（`participant_code`、`wechat_openid`、可选 `content_type`）。
2. 服务端校验参与者后生成 R2 **PUT 预签名 URL** 与 `object_key`（如 `uploads/{code}/h5/{uuid}.mp4`）。
3. 前端 **PUT** 文件至该 URL（**Content-Type 须与签名一致**）。
4. **`POST /upload/complete`** 写入 `video_submissions`（`source=h5`，`object_key` 与预签名一致）。

## 4. 审核与发布

- 审核可使用 R2 **临时访问链接**、公开域名、或带鉴权的下载代理；不在微信侧审片。
- 业务通知仍走模板消息等，与存储 key 解耦。

## 5. 备份与留存

- R2 **生命周期、版本管理与访问域名策略** 按合规与成本配置。
- 用户删除诉求需同步 **R2 对象删除 + 库表脱敏** 策略。
