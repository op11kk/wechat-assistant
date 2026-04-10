import Link from "next/link";

const endpointCards = [
  {
    title: "参与者登记",
    path: "POST /participants",
    detail: "写入 Supabase participants，自动分配六位 participant_code。",
  },
  {
    title: "微信回调",
    path: "GET|POST /api/wechat",
    detail: "验证服务号 URL，接收 video/shortvideo 并落库。",
  },
  {
    title: "大视频上传",
    path: "GET /h5",
    detail: "浏览器拿 R2 或 COS 预签名后直传，完成后回写 video_submissions（参与者须 active）。",
  },
];

export default function HomePage() {
  return (
    <main className="landing-shell">
      <section className="hero-panel">
        <p className="eyebrow">iosbehind</p>
        <h1>微信视频收集服务已经切到 Next.js + TypeScript。</h1>
        <p className="hero-copy">
          当前实现保留了原文档里的参与者登记、微信回调、H5 直传、审核接口，同时把对象存储切到了
          Cloudflare R2，业务元数据继续放在 Supabase。
        </p>
        <div className="hero-actions">
          <Link className="primary-link" href="/h5">
            打开上传页
          </Link>
          <Link className="secondary-link" href="/openapi.json">
            查看 OpenAPI
          </Link>
        </div>
      </section>

      <section className="card-grid">
        <article className="info-card" style={{ gridColumn: "1 / -1" }}>
          <p className="card-path">最短闭环</p>
          <h2>聊天发视频（最短闭环）</h2>
          <ol className="flow-steps">
            <li>
              浏览器打开 <code>GET /health</code>，确认 <code>checks</code> 里 Supabase、微信 Token 等是否就绪。
            </li>
            <li>
              微信关注测试号；需要时可向测试号发送 <code>openid</code> / <code>帮助</code>，按自动回复复制登记用的 OpenID。
            </li>
            <li>
              调用 <code>POST /participants</code>，JSON 含 <code>wechat_openid</code>、<code>real_name</code>、<code>phone</code>
              。若配置了 <code>API_SECRET</code>，请求头加 <code>Authorization: Bearer …</code>。
            </li>
            <li>
              用已登记的微信向测试号发<strong>视频</strong>或<strong>小视频</strong>；用 <code>GET /admin/submissions</code> 或{" "}
              <code>{`GET /admin/submissions/{id}`}</code> 查看记录（按需带 API 密钥）。拉取文件到云存储需配置{" "}
              <code>WECHAT_APP_ID</code> / <code>WECHAT_APP_SECRET</code> 与 R2 或 COS。
            </li>
          </ol>
        </article>
        {endpointCards.map((card) => (
          <article className="info-card" key={card.path}>
            <p className="card-path">{card.path}</p>
            <h2>{card.title}</h2>
            <p>{card.detail}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
