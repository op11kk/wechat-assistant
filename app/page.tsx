import Link from "next/link";

const endpointCards = [
  {
    title: "参与者登记",
    path: "POST /participants",
    detail: "写入 Supabase participants，自动分配六位 participant_code。",
  },
  {
    title: "微信回调",
    path: "GET|POST /wechat/callback",
    detail: "验证服务号 URL，接收 video/shortvideo 并落库。",
  },
  {
    title: "大视频上传",
    path: "GET /h5",
    detail: "浏览器拿 R2 预签名后直传，完成后回写 video_submissions。",
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
