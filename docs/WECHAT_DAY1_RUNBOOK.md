# 方案 B 第一天 Runbook：服务号回调 + 存储联调

目标：在 **1～2 个工作日** 内跑通 **微信服务器能连上你的 HTTPS 服务**、收到一条测试消息、并能将逻辑走通到「可扩展的业务处理」（哪怕先 echo）。

---

## 0. 前置清单

- [ ] 企业主体 **微信认证服务号**（或具备开发权限的测试号流程）
- [ ] 公网 **HTTPS** 域名（正式或开发用子域）
- [ ] Supabase 中已执行 **`schema_video_collector.sql`**（`participants` / `video_submissions`）
- [ ] 腾讯云 **COS** 存储桶与子账号 `SecretId`/`SecretKey`、地域（**仅服务端**；未填 COS 时对话框视频仍落库占位 `object_key`，大视频预签名不可用）
- [ ] 代码仓库已从远程拉取，`docs/01–06` 与本文对齐

---

## 1. 密钥与配置（不入库）

在服务端环境变量或密钥管理（示例名）：

- `WECHAT_TOKEN`、`WECHAT_APP_ID`、`WECHAT_APP_SECRET`（拉临时素材）；明文模式可不配 `EncodingAESKey`
- `COS_SECRET_ID`、`COS_SECRET_KEY`、`COS_REGION`、`COS_BUCKET`
- 业务数据库连接串

确认 `.gitignore` 含 `.env`，且 **`git status` 无密钥文件**。

---

## 2. 微信公众平台配置

路径大致：**开发 → 基本配置 → 服务器配置**

1. 填写 **URL**：`https://你的域/wechat/callback`（与代码一致）  
2. **Token**、**EncodingAESKey** 与服务器一致  
3. 先部署好 **GET 校验** 再点提交（平台会发起 GET 验证）

---

## 3. 最小 GET 校验（逻辑）

平台请求带 `signature`、`timestamp`、`nonce`、`echostr`：

- 将 `token`、`timestamp`、`nonce` 字典序排序、拼接、SHA1，与 `signature` 比对  
- 安全模式下还需按文档解密 `echostr`（若使用兼容/安全模式）

比对通过后 **原样返回** 明文 `echostr`。

---

## 4. 最小 POST 消息（逻辑）

1. 接收 body → 解密（若加密）→ 解析 XML/JSON  
2. 记录日志（脱敏）  
3. 返回 `success` 或按文档要求的空响应（避免重试）

首条联调可用 **明文模式**（仅测试环境），上线建议 **安全模式**。

---

## 5. 大视频 H5（可第二天做）

- 菜单 URL 指向静态页 + 后端 **预签名**  
- 手机微信内打开，选 **>200MB** 文件试传  
- `complete` 回调后 DB 有一条 `source=h5` 记录

---

## 6. 当天交付物（建议）

- [ ] 服务器配置 **启用成功** 截图（脱敏）  
- [ ] 一条真实用户消息 **后端日志可见**  
- [ ] Runbook 中 **URL、环境** 记在团队私有笔记（不进仓库）

---

## 文档位置

更早的本地 runbook 若曾存在于 Git 历史，可自行检出参考。
