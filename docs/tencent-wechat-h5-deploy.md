# 微信公众号 H5 视频上传部署说明

## 目标链路

```text
微信公众号菜单 / 消息入口
  -> https://api.capego.top/h5
  -> Nginx 反向代理
  -> Next.js (127.0.0.1:3000)
  -> PostgreSQL (127.0.0.1:5432)
  -> 腾讯云 COS
```

微信公众号服务器回调地址：

```text
https://api.capego.top/api/wechat
```

## 本机准备

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

项目根目录新建 `.env.local`，至少填写下面这些值：

```env
DATABASE_URL=postgresql://wechat_user:your-password@127.0.0.1:5432/wechat_assistant
API_SECRET=your-long-random-secret

WECHAT_TOKEN=your-wechat-token
WECHAT_APP_ID=your-wechat-app-id
WECHAT_APP_SECRET=your-wechat-app-secret

COS_SECRET_ID=your-cos-secret-id
COS_SECRET_KEY=your-cos-secret-key
COS_REGION=ap-guangzhou
COS_BUCKET=your-bucket-appid
COS_PUBLIC_BASE_URL=https://your-domain-or-cdn/
```

3. 初始化数据库

```bash
psql -h 127.0.0.1 -U wechat_user -d wechat_assistant -f schema_video_collector.sql
```

4. 启动项目

```bash
npm run dev
```

浏览器访问：

```text
http://127.0.0.1:3000/h5
```

说明：

- 根路径 `/` 已经自动跳转到 `/h5`，站点对外只保留一个 H5 上传入口。
- 用户先在公众号里发送 `上传码` 或 `openid`，系统会回复一个 6 位上传码。
- H5 页面只要求用户填写这个 6 位上传码，不再要求填写很长的微信 `openid`。

## Nginx 配置示例

```nginx
server {
    listen 80;
    server_name api.capego.top;

    client_max_body_size 200m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

如果已经接好 HTTPS，请把公众号回调地址和菜单地址都配置成 `https://api.capego.top/...`。

## 微信公众号后台配置

### 1. 服务器配置

- URL: `https://api.capego.top/api/wechat`
- Token: 与 `.env.local` 里的 `WECHAT_TOKEN` 保持一致
- EncodingAESKey: 当前代码走明文模式时可按公众号后台要求填写
- 消息加解密方式：优先保持和现在后台配置一致

保存时，微信会对 `GET /api/wechat` 发起校验请求；只要 Nginx 已转发到 Next.js，且 `WECHAT_TOKEN` 一致，就会通过。

### 2. 菜单入口

菜单 URL 建议直接指向：

```text
https://api.capego.top/h5
```

这样用户点菜单后会直接进入唯一的 H5 上传页。

### 3. 用户使用流程

1. 用户在公众号里发送 `上传码`
2. 公众号自动回复 6 位上传码
3. 用户打开 `https://api.capego.top/h5`
4. 用户输入 6 位上传码并上传视频

## 生产启动建议

先构建，再启动：

```bash
npm run build
npm run start
```

如果你用 `systemd` 或 `pm2`，确保服务最终监听在 `127.0.0.1:3000`，由 Nginx 统一对外暴露。

## 关键检查项

- `GET https://api.capego.top/health` 能返回健康状态。
- `GET https://api.capego.top/h5` 能打开页面。
- 微信公众号后台保存服务器配置时，`https://api.capego.top/api/wechat` 校验通过。
- 公众号菜单能打开 H5。
- H5 上传后，COS 桶内能看到文件，`video_submissions` 表里有记录。
