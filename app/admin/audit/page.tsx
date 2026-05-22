import Link from "next/link";
import { cookies } from "next/headers";

import LogoutButton from "@/app/components/LogoutButton";
import { APP_SESSION_COOKIE, getCurrentAppUserBySessionToken } from "@/lib/app-auth";
import { listAdminAuditEvents } from "@/lib/admin-audit";

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

function formatPayload(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload ?? {});
  if (text.length <= 120) {
    return text;
  }

  return `${text.slice(0, 120)}...`;
}

function formatActor(phone: string | null, role: string | null): string {
  if (phone) {
    return phone;
  }

  return role === "api" ? "系统接口" : "-";
}

export default async function AdminAuditPage() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(APP_SESSION_COOKIE)?.value ?? null;
  const user = await getCurrentAppUserBySessionToken(sessionToken);

  if (!user || user.role !== "admin") {
    return (
      <main className="landing-shell">
        <section className="hero-panel">
          <p className="eyebrow">Audit Logs</p>
          <h1>管理员账号可查看</h1>
          <p className="hero-copy">请先使用管理员账号登录，再查看后台操作日志。</p>
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

  const logs = await listAdminAuditEvents(200);

  return (
    <main className="landing-shell">
      <section className="hero-panel">
        <p className="eyebrow">Audit Logs</p>
        <h1>管理员操作日志</h1>
        <p className="hero-copy">
          这里记录账号角色修改、团长邀请码维护、采集员归属绑定和视频审核动作。后续上线后，这张表可以帮助你追踪“谁在什么时候改了什么”。
        </p>
        <div className="hero-actions">
          <Link className="primary-link" href="/admin">
            返回管理台
          </Link>
          <Link className="secondary-link" href="/admin/manage">
            账号与团队操作台
          </Link>
          <Link className="secondary-link" href="/admin/database">
            数据库历史数据
          </Link>
          <LogoutButton />
        </div>
      </section>

      <section className="status-panel dashboard-panel">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">Recent Actions</p>
            <h2>最近 200 条后台动作</h2>
          </div>
          <p className="dashboard-hint">日志只做追加记录，不参与业务判断；如果还没有动作，这里会先显示为空。</p>
        </div>

        {logs.length === 0 ? (
          <p className="empty-copy">当前还没有操作日志。你可以先去操作台修改一个账号或绑定一次团长，再回来刷新查看。</p>
        ) : (
          <div className="table-wrap">
            <table className="dashboard-table audit-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作人</th>
                  <th>角色</th>
                  <th>动作</th>
                  <th>对象</th>
                  <th>请求</th>
                  <th>内容</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td>{formatDateTime(log.createdAt)}</td>
                    <td>{formatActor(log.actorPhone, log.actorRole)}</td>
                    <td>{log.actorRole ?? "-"}</td>
                    <td>{log.action}</td>
                    <td>
                      {log.targetType}
                      {log.targetId ? ` #${log.targetId}` : ""}
                      {log.targetLabel ? ` ${log.targetLabel}` : ""}
                    </td>
                    <td>
                      {log.requestMethod ?? "-"} {log.requestPath ?? ""}
                    </td>
                    <td>
                      <code className="audit-payload">{formatPayload(log.payload)}</code>
                    </td>
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
