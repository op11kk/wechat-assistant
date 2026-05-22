import Link from "next/link";
import { cookies } from "next/headers";

import LogoutButton from "@/app/components/LogoutButton";
import { APP_SESSION_COOKIE, getCurrentAppUserBySessionToken } from "@/lib/app-auth";
import { getDomesticAdminDashboard, getDomesticAdminLeaderSearchByPromoCode } from "@/lib/domestic-mvp";

export const dynamic = "force-dynamic";

function formatDateTime(value: string | null): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

type AdminPageProps = {
  searchParams?: Promise<{
    leader_code?: string;
  }>;
};

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(APP_SESSION_COOKIE)?.value ?? null;
  const user = await getCurrentAppUserBySessionToken(sessionToken);
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const leaderCodeQuery = resolvedSearchParams?.leader_code?.trim() ?? "";

  if (!user) {
    return (
      <main className="landing-shell">
        <section className="hero-panel">
          <p className="eyebrow">Admin Portal</p>
          <h1>管理端</h1>
          <p className="hero-copy">先登录管理员账号后，再进入全局管理台查看团长、采集员和视频审核数据。</p>
          <div className="hero-actions">
            <Link className="primary-link" href="/login">
              去登录
            </Link>
            <Link className="secondary-link" href="/">
              返回总览
            </Link>
          </div>
        </section>
      </main>
    );
  }

  if (user.role !== "admin") {
    return (
      <main className="landing-shell">
        <section className="hero-panel">
          <p className="eyebrow">Admin Portal</p>
          <h1>当前账号不是管理员</h1>
          <p className="hero-copy">
            管理端只对 <code>admin</code> 角色开放。你现在登录的是 <code>{user.role}</code> 账号。
          </p>
          <div className="hero-actions">
            <Link className="primary-link" href="/login">
              切换账号
            </Link>
            <Link className="secondary-link" href="/">
              返回总览
            </Link>
          </div>
        </section>
      </main>
    );
  }

  const [dashboard, leaderCodeSearchResult] = await Promise.all([
    getDomesticAdminDashboard(),
    leaderCodeQuery ? getDomesticAdminLeaderSearchByPromoCode(leaderCodeQuery) : Promise.resolve(null),
  ]);

  return (
    <main className="landing-shell">
      <section className="hero-panel">
        <p className="eyebrow">Admin Portal</p>
        <h1>全局管理台</h1>
        <p className="hero-copy">
          管理端现在已经能看全局统计、团长列表和最近提交记录。现有审核接口保持不变，仍然可以继续复用
          <code>/admin/submissions</code> 这套链路。
        </p>
        <div className="hero-actions">
          <Link className="primary-link" href="/admin/submissions?limit=50">
            查看审核接口
          </Link>
          <Link className="secondary-link" href="/admin/people">
            团长 / 采集员管理表
          </Link>
          <Link className="secondary-link" href="/admin/manage">
            账号与团队操作台
          </Link>
          <Link className="secondary-link" href="/admin/database">
            数据库历史数据
          </Link>
          <Link className="secondary-link" href="/admin/audit">
            操作日志
          </Link>
          <Link className="secondary-link" href="/">
            返回总览
          </Link>
          <LogoutButton />
        </div>
      </section>

      <section className="card-grid">
        <article className="info-card stat-card">
          <p className="card-path">Collectors</p>
          <h2>{dashboard.summary.participantCount}</h2>
          <p>当前系统里的采集员总数。</p>
        </article>
        <article className="info-card stat-card">
          <p className="card-path">Leaders</p>
          <h2>{dashboard.summary.leaderCount}</h2>
          <p>当前系统里的团长总数。</p>
        </article>
        <article className="info-card stat-card">
          <p className="card-path">Submissions</p>
          <h2>{dashboard.summary.submissionCount}</h2>
          <p>累计视频提交总数。</p>
        </article>
        <article className="info-card stat-card">
          <p className="card-path">Pending</p>
          <h2>{dashboard.summary.pendingReviewCount}</h2>
          <p>待人工审核的视频数量。</p>
        </article>
      </section>

      <section className="card-grid">
        <article className="info-card">
          <p className="card-path">Approved</p>
          <h2>{dashboard.summary.approvedCount}</h2>
          <p>已审核通过的视频数量。</p>
        </article>
        <article className="info-card">
          <p className="card-path">Rejected</p>
          <h2>{dashboard.summary.rejectedCount}</h2>
          <p>已驳回的视频数量，后面可以继续接驳回原因统计。</p>
        </article>
        <article className="info-card">
          <p className="card-path">Current Scope</p>
          <h2>保留现有审核链路</h2>
          <p>这版不重写 worker 和人工审核接口，先把管理台的数据视图和角色入口补完整。</p>
        </article>
      </section>

      <section className="status-panel dashboard-panel">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">Leader Search</p>
            <h2>按团长码查团队视频</h2>
          </div>
          <p className="dashboard-hint">输入团长邀请码，可以看到这个团长管理的采集员，以及这些采集员上传的视频。</p>
        </div>

        <form className="form-grid compact-form" action="/admin" method="get">
          <div className="field">
            <label htmlFor="leaderCodeSearch">团长码 / 邀请码</label>
            <input id="leaderCodeSearch" name="leader_code" placeholder="例如 300003" defaultValue={leaderCodeQuery} />
          </div>
          <div className="field">
            <label>&nbsp;</label>
            <button className="submit-button" type="submit">
              搜索团队视频
            </button>
          </div>
        </form>

        {leaderCodeQuery ? (
          leaderCodeSearchResult ? (
            <div className="search-result-block">
              <div className="card-grid">
                <article className="info-card">
                  <p className="card-path">Leader</p>
                  <h2>{leaderCodeSearchResult.leader.promoterName}</h2>
                  <p>
                    团长码 <code>{leaderCodeSearchResult.leader.promoCode}</code>，采集员{" "}
                    {leaderCodeSearchResult.leader.participantCount} 人，累计上传{" "}
                    {leaderCodeSearchResult.leader.submissionCount} 条。
                  </p>
                </article>
                <article className="info-card">
                  <p className="card-path">Review</p>
                  <h2>{leaderCodeSearchResult.leader.pendingCount} 待审</h2>
                  <p>已通过 {leaderCodeSearchResult.leader.approvedCount} 条，团长状态 {leaderCodeSearchResult.leader.status}。</p>
                </article>
              </div>

              <div className="table-wrap">
                <table className="dashboard-table">
                  <thead>
                    <tr>
                      <th>采集员</th>
                      <th>上传码</th>
                      <th>手机号</th>
                      <th>状态</th>
                      <th>上传数</th>
                      <th>已通过</th>
                      <th>待审核</th>
                      <th>最近上传</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderCodeSearchResult.collectors.map((collector) => (
                      <tr key={collector.participantId}>
                        <td>{collector.realName}</td>
                        <td>{collector.participantCode}</td>
                        <td>{collector.phone}</td>
                        <td>{collector.status}</td>
                        <td>{collector.submissionCount}</td>
                        <td>{collector.approvedCount}</td>
                        <td>{collector.pendingCount}</td>
                        <td>{formatDateTime(collector.latestSubmittedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {leaderCodeSearchResult.submissions.length === 0 ? (
                <p className="empty-copy">这个团长名下目前还没有视频提交记录。</p>
              ) : (
                <div className="table-wrap">
                  <table className="dashboard-table">
                    <thead>
                      <tr>
                        <th>提交 ID</th>
                        <th>采集员</th>
                        <th>上传码</th>
                        <th>团长</th>
                        <th>来源</th>
                        <th>场景</th>
                        <th>审核状态</th>
                        <th>AI 状态</th>
                        <th>提交时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {leaderCodeSearchResult.submissions.map((submission) => (
                        <tr key={submission.submissionId}>
                          <td>{submission.submissionId}</td>
                          <td>{submission.participantName}</td>
                          <td>{submission.participantCode}</td>
                          <td>{submission.leaderName ?? "-"}</td>
                          <td>{submission.source}</td>
                          <td>{submission.scene ?? "-"}</td>
                          <td>{submission.reviewStatus}</td>
                          <td>{submission.analysisStatus ?? "-"}</td>
                          <td>{formatDateTime(submission.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <p className="empty-copy">没有找到团长码为 {leaderCodeQuery} 的团长。</p>
          )
        ) : null}
      </section>

      <section className="status-panel dashboard-panel">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">Leaders Table</p>
            <h2>团长团队汇总表</h2>
          </div>
          <p className="dashboard-hint">这张表对应之前讨论的“团长看上传量”的全局管理视角。</p>
        </div>

        {dashboard.leaders.length === 0 ? (
          <p className="empty-copy">当前还没有团长数据。</p>
        ) : (
          <div className="table-wrap">
            <table className="dashboard-table">
              <thead>
                <tr>
                  <th>团长</th>
                  <th>邀请码</th>
                  <th>状态</th>
                  <th>采集员数</th>
                  <th>上传数</th>
                  <th>待审核</th>
                  <th>已通过</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.leaders.map((leader) => (
                  <tr key={leader.leaderId}>
                    <td>{leader.promoterName}</td>
                    <td>{leader.promoCode}</td>
                    <td>{leader.status}</td>
                    <td>{leader.participantCount}</td>
                    <td>{leader.submissionCount}</td>
                    <td>{leader.pendingCount}</td>
                    <td>{leader.approvedCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="status-panel dashboard-panel">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">Recent Submissions</p>
            <h2>最近提交视频表</h2>
          </div>
          <p className="dashboard-hint">管理端可以直接从这里看最近谁上传了视频，以及当前审核状态。</p>
        </div>

        {dashboard.recentSubmissions.length === 0 ? (
          <p className="empty-copy">当前还没有视频提交记录。</p>
        ) : (
          <div className="table-wrap">
            <table className="dashboard-table">
              <thead>
                <tr>
                  <th>提交 ID</th>
                  <th>采集员</th>
                  <th>身份码</th>
                  <th>团长</th>
                  <th>来源</th>
                  <th>场景</th>
                  <th>审核状态</th>
                  <th>AI 状态</th>
                  <th>提交时间</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.recentSubmissions.map((submission) => (
                  <tr key={submission.submissionId}>
                    <td>{submission.submissionId}</td>
                    <td>{submission.participantName}</td>
                    <td>{submission.participantCode}</td>
                    <td>{submission.leaderName ?? "-"}</td>
                    <td>{submission.source}</td>
                    <td>{submission.scene ?? "-"}</td>
                    <td>{submission.reviewStatus}</td>
                    <td>{submission.analysisStatus ?? "-"}</td>
                    <td>{formatDateTime(submission.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
