import Link from "next/link";

export default function HomePage() {
  return (
    <main className="landing-shell">
      <section className="hero-panel">
        <p className="eyebrow">Domestic MVP</p>
        <h1>国内版视频采集系统</h1>
        <p className="hero-copy">
          这一版先聚焦中国大陆业务，保留现有 H5 上传、COS 存储、AI 预审与人工终审链路，去掉公众号耦合，改成三端入口：采集员端、团长端、管理端。
        </p>
        <div className="hero-actions">
          <Link className="primary-link" href="/register">
            手机号注册 / 登录
          </Link>
          <Link className="secondary-link" href="/collector">
            采集员端
          </Link>
          <Link className="secondary-link" href="/leader">
            团长端
          </Link>
          <Link className="secondary-link" href="/admin">
            管理端
          </Link>
        </div>
      </section>

      <section className="card-grid">
        <article className="info-card">
          <p className="card-path">Collector</p>
          <h2>采集员端</h2>
          <p>继续复用现有 H5 上传页，优先解决上传、审核状态和历史记录查询。</p>
        </article>
        <article className="info-card">
          <p className="card-path">Leader</p>
          <h2>团长端</h2>
          <p>第一版先做团队规模、提交量、待审核和通过量看板，后续再补个人权限与收益视图。</p>
        </article>
        <article className="info-card">
          <p className="card-path">Admin</p>
          <h2>管理端</h2>
          <p>复用现有审核接口和 worker 链路，先把全局数据、审核入口和进度统计放到一个管理工作台。</p>
        </article>
      </section>

      <section className="status-panel dashboard-panel">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">MVP Direction</p>
            <h2>这次国内版改造的边界</h2>
          </div>
        </div>
        <ol className="flow-steps">
          <li>保留 H5 上传、COS、审核 worker，不重写底层上传审核能力。</li>
          <li>去掉公众号消息驱动，后续用 Web 登录与角色体系替代 openid 驱动。</li>
          <li>先把三端入口跑通，再继续补账号体系、团队权限和结算模块。</li>
        </ol>
      </section>
    </main>
  );
}
