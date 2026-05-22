import Link from "next/link";
import { cookies } from "next/headers";

import AdminManageClient from "@/app/admin/manage/AdminManageClient";
import LogoutButton from "@/app/components/LogoutButton";
import { APP_SESSION_COOKIE, getCurrentAppUserBySessionToken } from "@/lib/app-auth";
import { getDomesticManageData } from "@/lib/domestic-admin";

export const dynamic = "force-dynamic";

export default async function AdminManagePage() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(APP_SESSION_COOKIE)?.value ?? null;
  const user = await getCurrentAppUserBySessionToken(sessionToken);

  if (!user || user.role !== "admin") {
    return (
      <main className="landing-shell">
        <section className="hero-panel">
          <p className="eyebrow">Admin Manage</p>
          <h1>管理员账号可操作</h1>
          <p className="hero-copy">请先使用管理员账号登录，再进入账号、团长和采集员的操作台。</p>
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

  const data = await getDomesticManageData();

  return (
    <main className="landing-shell">
      <section className="hero-panel">
        <p className="eyebrow">Admin Manage</p>
        <h1>账号与团队操作台</h1>
        <p className="hero-copy">
          这里把原来需要手写 SQL 的事情收进页面：修改账号角色、创建团长邀请码、绑定采集员归属。
        </p>
        <div className="hero-actions">
          <Link className="primary-link" href="/admin/people">
            查看人员表
          </Link>
          <Link className="secondary-link" href="/admin">
            返回管理台
          </Link>
          <Link className="secondary-link" href="/admin/audit">
            操作日志
          </Link>
          <LogoutButton />
        </div>
      </section>

      <AdminManageClient data={data} />
    </main>
  );
}
