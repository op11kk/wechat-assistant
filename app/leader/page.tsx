import Link from "next/link";
import { cookies } from "next/headers";

import LeaderManageClient from "@/app/leader/LeaderManageClient";
import LogoutButton from "@/app/components/LogoutButton";
import { APP_SESSION_COOKIE, getCurrentAppUserBySessionToken } from "@/lib/app-auth";
import {
  getDomesticLeaderDashboardByAppUserId,
  getDomesticLeaderParticipantSearchByCode,
} from "@/lib/domestic-mvp";

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

type LeaderPageProps = {
  searchParams?: Promise<{
    participant_code?: string;
    review?: string;
  }>;
};

export default async function LeaderPage({ searchParams }: LeaderPageProps) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(APP_SESSION_COOKIE)?.value ?? null;
  const user = await getCurrentAppUserBySessionToken(sessionToken);
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const reviewFilter =
    resolvedSearchParams?.review === "pending" ||
    resolvedSearchParams?.review === "approved" ||
    resolvedSearchParams?.review === "rejected"
      ? resolvedSearchParams.review
      : undefined;
  const participantCodeQuery = resolvedSearchParams?.participant_code?.trim() ?? "";

  if (!user) {
    return (
      <main className="landing-shell">
        <section className="hero-panel">
          <p className="eyebrow">Leader Portal</p>
          <h1>团长端</h1>
          <p className="hero-copy">
            先登录后再查看自己的团队数据。当前团长端会按登录账号，只展示你名下采集员和视频上传进度。
          </p>
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

  if (user.role !== "leader") {
    return (
      <main className="landing-shell">
        <section className="hero-panel">
          <p className="eyebrow">Leader Portal</p>
          <h1>当前账号不是团长</h1>
          <p className="hero-copy">
            团长端只对角色为 <code>leader</code> 的账号开放。你现在登录的是
            <code>{user.role}</code> 账号，请切换团长账号后再进入。
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

  const dashboard = await getDomesticLeaderDashboardByAppUserId(user.id, {
    reviewStatus: reviewFilter,
  });
  if (!dashboard) {
    return (
      <main className="landing-shell">
        <section className="hero-panel">
          <p className="eyebrow">Leader Portal</p>
          <h1>团长档案还未绑定</h1>
          <p className="hero-copy">
            当前账号已经是团长角色，但还没有绑定到 <code>team_leader_promoters.app_user_id</code>。
            管理员把这个账号和邀请码记录绑定后，这里就会自动显示你的团队表格。
          </p>
          <div className="hero-actions">
            <Link className="primary-link" href="/login">
              返回登录页
            </Link>
            <Link className="secondary-link" href="/">
              返回总览
            </Link>
          </div>
        </section>
      </main>
    );
  }

  const participantSearchResult = participantCodeQuery
    ? await getDomesticLeaderParticipantSearchByCode(dashboard.leader.leaderId, participantCodeQuery)
    : null;

  return (
    <main className="landing-shell">
      <section className="hero-panel">
        <p className="eyebrow">Leader Portal</p>
        <h1>{dashboard.leader.promoterName} 的团队看板</h1>
        <p className="hero-copy">
          这里只展示当前登录团长自己名下的采集员和提交进度。邀请码是 <code>{dashboard.leader.promoCode}</code>。
        </p>
        <div className="hero-actions">
          <Link className="primary-link" href="/collector">
            查看采集员端
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
          <h2>{dashboard.leader.participantCount}</h2>
          <p>当前绑定到你邀请码下的采集员数量。</p>
        </article>
        <article className="info-card stat-card">
          <p className="card-path">Submissions</p>
          <h2>{dashboard.leader.submissionCount}</h2>
          <p>团队累计视频上传数。</p>
        </article>
        <article className="info-card stat-card">
          <p className="card-path">Pending</p>
          <h2>{dashboard.leader.pendingCount}</h2>
          <p>还在待人工审核的视频数量。</p>
        </article>
        <article className="info-card stat-card">
          <p className="card-path">Approved</p>
          <h2>{dashboard.leader.approvedCount}</h2>
          <p>已审核通过的视频数量。</p>
        </article>
      </section>

      <LeaderManageClient collectors={dashboard.collectors} />

      <section className="status-panel dashboard-panel">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">Collector Search</p>
            <h2>按采集员上传码查视频</h2>
          </div>
          <p className="dashboard-hint">输入采集员的上传码/身份码，只会查询当前团长自己团队内的数据。</p>
        </div>

        <form className="form-grid compact-form" action="/leader" method="get">
          <div className="field">
            <label htmlFor="participantCodeSearch">采集员上传码</label>
            <input
              id="participantCodeSearch"
              name="participant_code"
              placeholder="例如 000001"
              defaultValue={participantCodeQuery}
            />
          </div>
          {reviewFilter ? <input name="review" type="hidden" value={reviewFilter} /> : null}
          <div className="field">
            <label>&nbsp;</label>
            <button className="submit-button" type="submit">
              搜索采集员视频
            </button>
          </div>
        </form>

        {participantCodeQuery ? (
          participantSearchResult ? (
            <div className="search-result-block">
              <div className="card-grid">
                <article className="info-card">
                  <p className="card-path">Collector</p>
                  <h2>{participantSearchResult.collector.realName}</h2>
                  <p>
                    上传码 <code>{participantSearchResult.collector.participantCode}</code>，手机号{" "}
                    <code>{participantSearchResult.collector.phone}</code>，累计上传{" "}
                    {participantSearchResult.collector.submissionCount} 条。
                  </p>
                </article>
                <article className="info-card">
                  <p className="card-path">Review</p>
                  <h2>{participantSearchResult.collector.pendingCount} 待审</h2>
                  <p>已通过 {participantSearchResult.collector.approvedCount} 条，最近上传 {formatDateTime(participantSearchResult.collector.latestSubmittedAt)}。</p>
                </article>
              </div>

              {participantSearchResult.submissions.length === 0 ? (
                <p className="empty-copy">这个采集员目前还没有视频提交记录。</p>
              ) : (
                <div className="table-wrap">
                  <table className="dashboard-table">
                    <thead>
                      <tr>
                        <th>提交 ID</th>
                        <th>采集员</th>
                        <th>上传码</th>
                        <th>来源</th>
                        <th>场景</th>
                        <th>审核状态</th>
                        <th>AI 状态</th>
                        <th>提交时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {participantSearchResult.submissions.map((submission) => (
                        <tr key={submission.submissionId}>
                          <td>{submission.submissionId}</td>
                          <td>{submission.participantName}</td>
                          <td>{submission.participantCode}</td>
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
            <p className="empty-copy">没有找到上传码为 {participantCodeQuery} 的团队采集员。</p>
          )
        ) : null}
      </section>

      <section className="status-panel dashboard-panel">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">Collectors Table</p>
            <h2>采集员上传情况表</h2>
          </div>
          <p className="dashboard-hint">这张表只统计当前团长名下的采集员。</p>
        </div>

        {dashboard.collectors.length === 0 ? (
          <p className="empty-copy">当前还没有绑定到你邀请码下的采集员。</p>
        ) : (
          <div className="table-wrap">
            <table className="dashboard-table">
              <thead>
                <tr>
                  <th>采集员</th>
                  <th>身份码</th>
                  <th>手机号</th>
                  <th>状态</th>
                  <th>上传数</th>
                  <th>已通过</th>
                  <th>待审核</th>
                  <th>最近上传</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.collectors.map((collector) => (
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
        )}
      </section>

      <section className="status-panel dashboard-panel">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">Recent Uploads</p>
            <h2>最近上传视频表</h2>
          </div>
          <div className="hero-actions">
            <Link className={reviewFilter === undefined ? "primary-link" : "secondary-link"} href="/leader">
              全部
            </Link>
            <Link className={reviewFilter === "pending" ? "primary-link" : "secondary-link"} href="/leader?review=pending">
              待审核
            </Link>
            <Link className={reviewFilter === "approved" ? "primary-link" : "secondary-link"} href="/leader?review=approved">
              已通过
            </Link>
            <Link className={reviewFilter === "rejected" ? "primary-link" : "secondary-link"} href="/leader?review=rejected">
              已驳回
            </Link>
          </div>
        </div>

        {dashboard.recentSubmissions.length === 0 ? (
          <p className="empty-copy">当前还没有视频上传记录。</p>
        ) : (
          <div className="table-wrap">
            <table className="dashboard-table">
              <thead>
                <tr>
                  <th>提交 ID</th>
                  <th>采集员</th>
                  <th>身份码</th>
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
