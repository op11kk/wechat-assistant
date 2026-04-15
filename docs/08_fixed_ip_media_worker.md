# 微信素材固定 IP Worker 部署说明

## 1. 为什么需要 Worker

微信公众号获取 `access_token` 和下载临时素材时，会校验公众号后台的 API IP 白名单。

Vercel 的出口 IP 不固定，所以可能今天成功、明天失败，并出现：

```text
errcode: 40164
invalid ip ... not in whitelist
```

解决办法是把“微信素材下载 + 上传 COS + 回写 Supabase”迁移到一个固定公网出口 IP 的服务上，例如腾讯云轻量服务器或 CVM。

## 2. 最终架构

```text
微信公众号
  -> Vercel /api/wechat
  -> Supabase 先写入 video_submissions，object_key = wechat/pending/{media_id}
  -> Vercel 调用固定 IP Worker
  -> Worker 获取微信 access_token
  -> Worker 下载微信 media_id
  -> Worker 上传腾讯云 COS
  -> Worker 回写 Supabase object_key / object_url / size_bytes / mime
```

## 3. 需要配置的两边环境变量

### 3.1 Vercel 环境变量

Vercel 只需要知道 Worker 地址和调用密钥：

```text
WECHAT_MEDIA_WORKER_URL=https://你的固定IP域名/wechat-media-sync
WECHAT_MEDIA_WORKER_SECRET=一串随机长密钥
WECHAT_MEDIA_WORKER_TIMEOUT_MS=10000
```

`WECHAT_MEDIA_WORKER_SECRET` 要和 Worker 服务器上的 `WORKER_SECRET` 完全一致。

配置后重新部署 Vercel。

### 3.2 固定 IP Worker 环境变量

在腾讯云轻量服务器或 CVM 上配置：

```text
PORT=7001
WORKER_SECRET=一串随机长密钥

WECHAT_APP_ID=公众号AppId
WECHAT_APP_SECRET=公众号AppSecret

SUPABASE_URL=你的Supabase地址
SUPABASE_KEY=你的Supabase service_role key

COS_SECRET_ID=腾讯云COS SecretId
COS_SECRET_KEY=腾讯云COS SecretKey
COS_REGION=ap-guangzhou
COS_BUCKET=你的bucket完整名称
COS_PUBLIC_BASE_URL=https://你的COS公开访问域名
```

## 4. 腾讯云侧操作

1. 创建腾讯云轻量服务器或 CVM。
2. 绑定固定公网 IP。
3. 在公众号后台 API IP 白名单中添加这台服务器的公网 IP。
4. 安装 Node.js 20+。
5. 拉取本项目代码。
6. 执行：

```bash
npm install --omit=dev
npm run worker:wechat-media
```

7. 确认健康检查：

```bash
curl http://127.0.0.1:7001/health
```

预期：

```json
{"status":"ok"}
```

## 5. 建议使用 Nginx 反向代理

推荐对外暴露 HTTPS：

```text
https://media-worker.your-domain.com/wechat-media-sync
```

Nginx 转发到本机：

```text
127.0.0.1:7001
```

这样 Vercel 里配置：

```text
WECHAT_MEDIA_WORKER_URL=https://media-worker.your-domain.com/wechat-media-sync
```

## 6. 安全要求

1. Worker 必须使用 HTTPS。
2. `WORKER_SECRET` 必须是随机长字符串。
3. 不要把 Worker 的 `/wechat-media-sync` 暴露为无鉴权接口。
4. Supabase 必须使用 service_role key，但只放在 Worker 服务器环境变量里。
5. 微信 AppSecret 也只放在 Worker 服务器环境变量里。

## 7. 验证流程

1. Vercel 新部署完成。
2. 公众号上传一个新视频。
3. Vercel Logs 应看到：

```text
wechat media worker dispatch started
wechat media worker dispatch completed
```

4. Worker 服务器日志应看到：

```text
worker wechat token request succeeded
worker wechat media download completed
worker cos upload completed
worker media sync completed
```

5. Supabase 新视频记录应更新：

```text
object_key = uploads/{participant_code}/chat/{submission_id}.mp4
size_bytes = 视频大小
mime = 视频类型
```

6. COS 中应出现对应文件：

```text
uploads/{participant_code}/chat/{submission_id}.mp4
```

## 8. 回退方式

如果 Worker 暂时不可用，可以删除或清空 Vercel 的：

```text
WECHAT_MEDIA_WORKER_URL
WECHAT_MEDIA_WORKER_SECRET
```

重新部署后，系统会回退到 Vercel 本地同步逻辑。
