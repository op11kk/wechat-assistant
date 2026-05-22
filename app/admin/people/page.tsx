import Link from "next/link";
import { cookies } from "next/headers";

import LogoutButton from "@/app/components/LogoutButton";
import { APP_SESSION_COOKIE, getCurrentAppUserBySessionToken } from "@/lib/app-auth";
import { getDomesticAdminCollectorRows, getDomesticAdminLeaderRows } from "@/lib/domestic-mvp";

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

export default async function AdminPeoplePage() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(APP_SESSION_COOKIE)?.value ?? null;
  const user = await getCurrentAppUserBySessionToken(sessionToken);

  if (!user || user.role !== "admin") {
    return (
      <main className="landing-shell">
        <section className="hero-panel">
          <p className="eyebrow">Admin People</p>
          <h1>管理员账号可见</h1>
          <p className="hero-copy">这个页面只给管理员看，用来核对团长账号、邀请码、采集员账号和绑定关系。</p>
          <div className="hero-actions">
            <Link className="primary-link" href="/login">
              去登录
            </Link>
            <Link className="secondary-link" href="/admin">
              返回管理台
            </Link>
          </div>
        </section>
      </main>
    );
  }

  const [leaders, collectors] = await Promise.all([
    getDomesticAdminLeaderRows(100),
    getDomesticAdminCollectorRows(200),
  ]);

  return (
    <main className="landing-shell">
      <section className="hero-panel">
        <p className="eyebrow">Admin People</p>
        <h1>团长 / 采集员管理表</h1>
        <p className="hero-copy">
          这里主要用来核对三件事：账号角色是否对、团长邀请码是否绑定到账号、采集员是否已经挂到团长名下并开始上传。
        </p>
        <div className="hero-actions">
          <Link className="primary-link" href="/admin">
            返回管理台
          </Link>
          <Link className="secondary-link" href="/admin/manage">
            去操作台
          </Link>
          <Link className="secondary-link" href="/login">
            切换账号
          </Link>
          <LogoutButton />
        </div>
      </section>

      <section className="status-panel dashboard-panel">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">Leaders</p>
            <h2>团长账号与邀请码表</h2>
          </div>
          <p className="dashboard-hint">重点看团长账号手机号和邀请码记录是否已经绑定到同一个 app_user_id。</p>
        </div>

        {leaders.length === 0 ? (
          <p className="empty-copy">当前还没有团长记录。</p>
        ) : (
          <div className="table-wrap">
            <table className="dashboard-table">
              <thead>
                <tr>
                  <th>团长</th>
                  <th>邀请码</th>
                  <th>团长状态</th>
                  <th>账号手机号</th>
                  <th>账号状态</th>
                  <th>采集员数</th>
                  <th>上传数</th>
                  <th>待审核</th>
                  <th>已通过</th>
                </tr>
              </thead>
              <tbody>
                {leaders.map((leader) => (
                  <tr key={leader.leaderId}>
                    <td>{leader.promoterName}</td>
                    <td>{leader.promoCode}</td>
                    <td>{leader.leaderStatus}</td>
                    <td>{leader.appUserPhone ?? "-"}</td>
                    <td>{leader.accountStatus ?? "-"}</td>
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
            <p className="eyebrow">Collectors</p>
            <h2>采集员账号与绑定关系表</h2>
          </div>
          <p className="dashboard-hint">重点看采集员身份码、账号手机号、所属团长和最近上传时间。</p>
        </div>

        {collectors.length === 0 ? (
          <p className="empty-copy">当前还没有采集员记录。</p>
        ) : (
          <div className="table-wrap">
            <table className="dashboard-table">
              <thead>
                <tr>
                  <th>采集员</th>
                  <th>身份码</th>
                  <th>手机号</th>
                  <th>采集员状态</th>
                  <th>账号手机号</th>
                  <th>账号状态</th>
                  <th>所属团长</th>
                  <th>邀请码</th>
                  <th>上传数</th>
                  <th>待审核</th>
                  <th>已通过</th>
                  <th>最近上传</th>
                </tr>
              </thead>
              <tbody>
                {collectors.map((collector) => (
                  <tr key={collector.participantId}>
                    <td>{collector.realName}</td>
                    <td>{collector.participantCode}</td>
                    <td>{collector.phone}</td>
                    <td>{collector.participantStatus}</td>
                    <td>{collector.appUserPhone ?? "-"}</td>
                    <td>{collector.accountStatus ?? "-"}</td>
                    <td>{collector.leaderName ?? "未绑定"}</td>
                    <td>{collector.leaderPromoCode ?? "-"}</td>
                    <td>{collector.submissionCount}</td>
                    <td>{collector.pendingCount}</td>
                    <td>{collector.approvedCount}</td>
                    <td>{formatDateTime(collector.latestSubmittedAt)}</td>
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
