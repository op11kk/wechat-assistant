import Link from "next/link";
import { cookies } from "next/headers";

import LogoutButton from "@/app/components/LogoutButton";
import { APP_SESSION_COOKIE, getCurrentAppUserBySessionToken } from "@/lib/app-auth";
import { findParticipantByAppUserId } from "@/lib/video-submissions";

export const dynamic = "force-dynamic";

export default async function CollectorPage() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(APP_SESSION_COOKIE)?.value ?? null;
  const user = await getCurrentAppUserBySessionToken(sessionToken);
  const participant = user?.role === "collector" ? await findParticipantByAppUserId(user.id) : null;
  const uploadHref = participant ? `/h5?code=${encodeURIComponent(participant.participant_code)}` : "/h5";

  return (
    <main className="landing-shell">
      <section className="hero-panel">
        <p className="eyebrow">Domestic MVP</p>
        <h1>采集员端</h1>
        <p className="hero-copy">
          国内版最小可行方案先复用现有 H5 上传链路。采集员通过 Web 或 H5 进入上传页，提交视频到广州 COS，并在同一页面查看审核状态与历史记录。
        </p>
        <div className="hero-actions">
          <Link className="primary-link" href="/">
            统一登录
          </Link>
          <Link className="secondary-link" href={uploadHref}>
            进入上传页
          </Link>
          <Link className="secondary-link" href="/">
            返回总览
          </Link>
          {user ? <LogoutButton /> : null}
        </div>
      </section>

      <section className="collector-code-panel">
        <div>
          <p className="eyebrow">Upload Code</p>
          <h2>我的上传码</h2>
          {participant ? (
            <p className="collector-code-value">{participant.participant_code}</p>
          ) : (
            <p className="collector-code-empty">
              当前账号还没有找到采集员档案。请先用团长码完成注册，或让管理员检查采集员是否已绑定到这个账号。
            </p>
          )}
        </div>
        <div className="collector-code-actions">
          {participant ? (
            <>
              <Link className="primary-link" href={uploadHref}>
                用这个码上传
              </Link>
              <span>上传页会自动填入身份码，无需再手动复制。</span>
            </>
          ) : (
            <Link className="primary-link" href="/">
              返回统一登录
            </Link>
          )}
        </div>
      </section>

      <section className="card-grid">
        <article className="info-card">
          <p className="card-path">MVP Scope</p>
          <h2>本期保留</h2>
          <p>分片上传、COS 存储、视频审核 worker、历史记录查询，以及测试/正式视频流程状态。</p>
        </article>
        <article className="info-card">
          <p className="card-path">Auth</p>
          <h2>手机号注册</h2>
          <p>这次已经补上手机号注册和登录接口。注册成功后会自动创建采集员账号和采集员档案。</p>
        </article>
        <article className="info-card">
          <p className="card-path">Current Path</p>
          <h2>当前入口</h2>
          <p>现阶段仍使用 <code>/h5</code> 作为上传主页面，等账号体系完全接入后再切成采集员登录态入口。</p>
        </article>
      </section>
    </main>
  );
}
