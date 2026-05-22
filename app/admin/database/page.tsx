import Link from "next/link";
import { cookies } from "next/headers";

import LogoutButton from "@/app/components/LogoutButton";
import { APP_SESSION_COOKIE, getCurrentAppUserBySessionToken } from "@/lib/app-auth";
import { getDomesticDatabaseSnapshot } from "@/lib/domestic-database";

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

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "-";
  }

  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(2)} MB`;
  }

  return `${(value / 1024).toFixed(1)} KB`;
}

function shortText(value: string | null, maxLength = 46): string {
  if (!value) {
    return "-";
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

export default async function AdminDatabasePage() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(APP_SESSION_COOKIE)?.value ?? null;
  const user = await getCurrentAppUserBySessionToken(sessionToken);

  if (!user || user.role !== "admin") {
    return (
      <main className="landing-shell">
        <section className="hero-panel">
          <p className="eyebrow">Database View</p>
          <h1>管理员账号可查看</h1>
          <p className="hero-copy">请先使用管理员账号登录，再查看当前 PostgreSQL 数据库里的历史记录。</p>
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

  const snapshot = await getDomesticDatabaseSnapshot();

  return (
    <main className="landing-shell">
      <section className="hero-panel">
        <p className="eyebrow">Database View</p>
        <h1>数据库历史数据总览</h1>
        <p className="hero-copy">
          这里直接读取你当前 <code>DATABASE_URL</code> 指向的 PostgreSQL 库，把旧的采集员、上传会话、视频提交和账号数据集中展示出来。
        </p>
        <div className="hero-actions">
          <Link className="primary-link" href="/admin">
            返回管理台
          </Link>
          <Link className="secondary-link" href="/admin/people">
            人员管理表
          </Link>
          <Link className="secondary-link" href="/admin/manage">
            操作台
          </Link>
          <LogoutButton />
        </div>
      </section>

      <section className="card-grid">
        <article className="info-card stat-card">
          <p className="card-path">App Users</p>
          <h2>{snapshot.counts.appUsers}</h2>
          <p>手机号登录账号数量。</p>
        </article>
        <article className="info-card stat-card">
          <p className="card-path">Participants</p>
          <h2>{snapshot.counts.participants}</h2>
          <p>采集员档案数量。</p>
        </article>
        <article className="info-card stat-card">
          <p className="card-path">Upload Sessions</p>
          <h2>{snapshot.counts.uploadSessions}</h2>
          <p>历史分片上传会话数量。</p>
        </article>
        <article className="info-card stat-card">
          <p className="card-path">Submissions</p>
          <h2>{snapshot.counts.videoSubmissions}</h2>
          <p>历史视频提交数量。</p>
        </article>
      </section>

      <section className="status-panel dashboard-panel">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">Video Submissions</p>
            <h2>历史视频提交记录</h2>
          </div>
          <p className="dashboard-hint">重点看 COS 对象、审核状态、AI 状态和提交时间。</p>
        </div>
        <div className="table-wrap">
          <table className="dashboard-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>采集员</th>
                <th>身份码</th>
                <th>团长</th>
                <th>来源</th>
                <th>文件</th>
                <th>大小</th>
                <th>审核</th>
                <th>AI</th>
                <th>COS Key</th>
                <th>提交时间</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.videoSubmissions.map((submission) => (
                <tr key={submission.id}>
                  <td>{submission.id}</td>
                  <td>{submission.participantName ?? "-"}</td>
                  <td>{submission.participantCode}</td>
                  <td>{submission.leaderName ?? "-"}</td>
                  <td>{submission.source}</td>
                  <td title={submission.fileName ?? undefined}>{shortText(submission.fileName, 24)}</td>
                  <td>{formatBytes(submission.sizeBytes)}</td>
                  <td>{submission.reviewStatus}</td>
                  <td>{submission.analysisStatus ?? "-"}</td>
                  <td title={submission.objectKey ?? undefined}>{shortText(submission.objectKey)}</td>
                  <td>{formatDateTime(submission.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="status-panel dashboard-panel">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">Participants</p>
            <h2>采集员历史档案</h2>
          </div>
          <p className="dashboard-hint">这里会展示旧表里的采集员身份码、手机号、测试/正式状态和账号绑定情况。</p>
        </div>
        <div className="table-wrap">
          <table className="dashboard-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>身份码</th>
                <th>姓名</th>
                <th>手机号</th>
                <th>状态</th>
                <th>测试状态</th>
                <th>正式状态</th>
                <th>团长</th>
                <th>账号手机号</th>
                <th>创建时间</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.participants.map((participant) => (
                <tr key={participant.id}>
                  <td>{participant.id}</td>
                  <td>{participant.participantCode}</td>
                  <td>{participant.realName}</td>
                  <td>{participant.phone}</td>
                  <td>{participant.status}</td>
                  <td>{participant.testStatus ?? "-"}</td>
                  <td>{participant.formalStatus ?? "-"}</td>
                  <td>{participant.leaderName ?? "-"}</td>
                  <td>{participant.appUserPhone ?? "-"}</td>
                  <td>{formatDateTime(participant.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="status-panel dashboard-panel">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">Upload Sessions</p>
            <h2>历史上传会话</h2>
          </div>
          <p className="dashboard-hint">这里看的是上传过程记录，能帮助判断文件是否完成上传到 COS。</p>
        </div>
        <div className="table-wrap">
          <table className="dashboard-table">
            <thead>
              <tr>
                <th>Session ID</th>
                <th>采集员</th>
                <th>身份码</th>
                <th>来源</th>
                <th>文件</th>
                <th>大小</th>
                <th>状态</th>
                <th>COS Key</th>
                <th>创建时间</th>
                <th>完成时间</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.uploadSessions.map((session) => (
                <tr key={session.id}>
                  <td title={session.id}>{shortText(session.id, 18)}</td>
                  <td>{session.participantName ?? "-"}</td>
                  <td>{session.participantCode}</td>
                  <td>{session.source}</td>
                  <td title={session.fileName ?? undefined}>{shortText(session.fileName, 24)}</td>
                  <td>{formatBytes(session.sizeBytes)}</td>
                  <td>{session.status}</td>
                  <td title={session.objectKey ?? undefined}>{shortText(session.objectKey)}</td>
                  <td>{formatDateTime(session.createdAt)}</td>
                  <td>{formatDateTime(session.completedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="status-panel dashboard-panel">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">Accounts</p>
            <h2>手机号账号记录</h2>
          </div>
          <p className="dashboard-hint">这里展示新账号体系里的角色、状态和最近登录时间。</p>
        </div>
        <div className="table-wrap">
          <table className="dashboard-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>手机号</th>
                <th>角色</th>
                <th>状态</th>
                <th>显示名</th>
                <th>实名</th>
                <th>最近登录</th>
                <th>创建时间</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.accounts.map((account) => (
                <tr key={account.id}>
                  <td>{account.id}</td>
                  <td>{account.phone}</td>
                  <td>{account.role}</td>
                  <td>{account.status}</td>
                  <td>{account.displayName}</td>
                  <td>{account.realName ?? "-"}</td>
                  <td>{formatDateTime(account.lastLoginAt)}</td>
                  <td>{formatDateTime(account.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
