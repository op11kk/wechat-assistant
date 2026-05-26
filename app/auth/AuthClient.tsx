"use client";

import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";

import { legalDeclarationParagraphs, legalDeclarationTitle } from "@/lib/legal-declaration";

type Mode = "login" | "register";
type AppRole = "admin" | "leader" | "collector";

type AuthResponse = {
  ok: boolean;
  detail?: string;
  error?: string;
  redirect_path?: string;
  redirectPath?: string;
  role?: AppRole;
  user?: {
    role?: AppRole;
    phone?: string;
    display_name?: string | null;
    real_name?: string | null;
  };
};

type AuthClientProps = {
  initialMode?: Mode;
  lockMode?: boolean;
  totalLogin?: boolean;
};

const roleLabels: Record<AppRole, string> = {
  admin: "管理员",
  leader: "团长",
  collector: "采集员",
};

function getRoleLabel(role?: AppRole): string | null {
  return role ? roleLabels[role] : null;
}

function getRedirectPath(result: AuthResponse): string {
  return result.redirect_path || result.redirectPath || "/";
}

async function parseJsonResponse(response: Response): Promise<AuthResponse> {
  const text = await response.text();
  if (!text.trim()) {
    return {
      ok: false,
      detail: `服务端返回空响应（HTTP ${response.status}）。`,
    };
  }

  try {
    return JSON.parse(text) as AuthResponse;
  } catch {
    return {
      ok: false,
      detail: `服务端返回了非 JSON 响应（HTTP ${response.status}）。`,
    };
  }
}

async function postJson(path: string, body: Record<string, unknown>): Promise<AuthResponse> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return parseJsonResponse(response);
}

export default function AuthClient({ initialMode = "register", lockMode = false, totalLogin = false }: AuthClientProps) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [realName, setRealName] = useState("");
  const [teamCode, setTeamCode] = useState("");
  const [agreementAccepted, setAgreementAccepted] = useState(false);
  const [agreementDialogOpen, setAgreementDialogOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const agreementHint = useMemo(() => {
    if (mode === "register") {
      return "采集员注册前必须勾选并同意法律协议。";
    }
    return "采集员和团长登录前必须勾选并同意法律协议，管理员账号可跳过。";
  }, [mode]);

  const heroTitle = mode === "register" ? "采集员自助注册" : totalLogin ? "统一登录入口" : "手机号登录";
  const heroCopy =
    mode === "register"
      ? "输入手机号、真实姓名和团长码，设置密码后就能自动绑定到对应团长团队。"
      : totalLogin
        ? "输入手机号和密码，系统会按这个手机号在新表里的账号角色，自动进入采集员端、团长端或管理端。"
        : "使用手机号和密码登录，系统会按账号角色进入对应端。";
  const wechatStartHref = `/api/auth/wechat/start${teamCode ? `?team_code=${encodeURIComponent(teamCode)}` : ""}`;

  function handleAgreementToggle(checked: boolean) {
    if (checked) {
      setAgreementDialogOpen(true);
      return;
    }
    setAgreementAccepted(false);
  }

  function confirmAgreement() {
    setAgreementAccepted(true);
    setAgreementDialogOpen(false);
    setMessage("");
  }

  function renderAgreementDialog() {
    if (!agreementDialogOpen) {
      return null;
    }

    return (
      <div className="agreement-modal-backdrop" role="presentation">
        <section
          aria-labelledby="agreementDialogTitle"
          aria-modal="true"
          className="agreement-modal"
          role="dialog"
        >
          <div className="agreement-modal-header">
            <div>
              <p className="eyebrow">Legal Notice</p>
              <h2 id="agreementDialogTitle">{legalDeclarationTitle}</h2>
            </div>
            <button
              aria-label="关闭声明详情"
              className="agreement-icon-button"
              onClick={() => setAgreementDialogOpen(false)}
              type="button"
            >
              ×
            </button>
          </div>

          <div className="agreement-modal-body">
            {legalDeclarationParagraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>

          <div className="agreement-modal-actions">
            <button className="secondary-link" onClick={() => setAgreementDialogOpen(false)} type="button">
              暂不同意
            </button>
            <button className="submit-button agreement-confirm-button" onClick={confirmAgreement} type="button">
              我已阅读并同意
            </button>
          </div>
        </section>
      </div>
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");

    if (!agreementAccepted) {
      setMessage("请先打开并确认《数据采集与授权声明》。");
      setAgreementDialogOpen(true);
      return;
    }

    if (mode === "register" && password !== confirmPassword) {
      setMessage("两次输入的密码不一致。");
      return;
    }

    setSubmitting(true);

    try {
      const payload =
        mode === "register"
          ? {
              phone,
              password,
              team_code: teamCode,
              display_name: realName || null,
              real_name: realName || null,
              agreement_accepted: agreementAccepted,
            }
          : {
              phone,
              password,
              agreement_accepted: agreementAccepted,
            };

      const result = await postJson(mode === "register" ? "/api/auth/register" : "/api/auth/login", payload);
      if (!result.ok) {
        setMessage(result.detail || "请求失败，请稍后重试。");
        return;
      }

      const roleLabel = getRoleLabel(result.user?.role || result.role);
      setMessage(roleLabel ? `${roleLabel}登录成功，正在进入对应端...` : mode === "register" ? "注册成功，正在进入采集员端..." : "登录成功，正在跳转...");
      window.setTimeout(() => {
        window.location.href = getRedirectPath(result);
      }, 400);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "网络异常，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  if (totalLogin) {
    return (
      <main className="auth-gateway-shell">
        <nav className="auth-topbar" aria-label="主导航">
          <Link className="auth-logo" href="/">
            <span className="auth-logo-mark">采</span>
            <strong>视频采集</strong>
          </Link>
          <div className="auth-topbar-links">
            <span>采集员</span>
            <span>团长</span>
            <span>管理员</span>
            <Link className="primary-link auth-topbar-cta" href="/register">
              开始
            </Link>
          </div>
        </nav>

        <section className="auth-gateway-brand">
          <p className="eyebrow">Domestic Gateway</p>
          <h1>视频采集</h1>
          <p className="auth-gateway-copy">统一入口</p>
          <div className="auth-gateway-roles" aria-label="可登录角色">
            <span>采集员</span>
            <span>团长</span>
            <span>管理员</span>
          </div>
        </section>

        <section className="auth-gateway-card">
          <div className="auth-card-header">
            <p className="eyebrow">Login</p>
            <h2>手机号登录</h2>
          </div>

          <div className="auth-toggle auth-gateway-toggle">
            <span className="primary-link">登录</span>
            <Link className="secondary-link" href="/register">
              没有账号，去注册
            </Link>
          </div>

          <a className="secondary-link auth-gateway-wechat" href={wechatStartHref}>
            微信进入 / 授权
          </a>
          <div className="auth-divider">
            <span>或使用手机号密码</span>
          </div>

          <form className="auth-gateway-form" onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="phone">手机号</label>
              <input
                id="phone"
                inputMode="numeric"
                maxLength={11}
                placeholder="请输入 11 位大陆手机号"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="password">密码</label>
              <input
                id="password"
                minLength={6}
                placeholder="请输入密码"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            <div className="auth-compact-agreement">
              <input
                checked={agreementAccepted}
                onChange={(event) => handleAgreementToggle(event.target.checked)}
                type="checkbox"
              />
              <span>
                我已阅读并同意
                <button className="agreement-text-button" onClick={() => setAgreementDialogOpen(true)} type="button">
                  《{legalDeclarationTitle}》
                </button>
              </span>
            </div>

            <button className="submit-button auth-gateway-submit" disabled={submitting} type="submit">
              {submitting ? "提交中..." : "登录"}
            </button>
          </form>

          {message ? (
            <p aria-live="polite" className="auth-message auth-gateway-message">
              {message}
            </p>
          ) : null}
        </section>
        {renderAgreementDialog()}
      </main>
    );
  }

  return (
    <main className="landing-shell">
      <section className="hero-panel">
        <p className="eyebrow">{mode === "register" ? "Collector Signup" : "Domestic Auth"}</p>
        <h1>{heroTitle}</h1>
        <p className="hero-copy">{heroCopy}</p>
      </section>

      <section className="upload-panel auth-panel">
        {lockMode ? (
          <div className="auth-toggle">
            <span className="primary-link">{mode === "register" ? "注册" : "登录"}</span>
            <Link className="secondary-link" href={mode === "register" ? "/" : "/register"}>
              {mode === "register" ? "已有账号，去登录" : "没有账号，去注册"}
            </Link>
          </div>
        ) : (
          <div className="auth-toggle">
            <button
              className={mode === "register" ? "primary-link" : "secondary-link"}
              onClick={() => setMode("register")}
              type="button"
            >
              注册
            </button>
            <button
              className={mode === "login" ? "primary-link" : "secondary-link"}
              onClick={() => setMode("login")}
              type="button"
            >
              登录
            </button>
          </div>
        )}

        <div className="auth-side-channel">
          <a className="secondary-link auth-gateway-wechat" href={wechatStartHref}>
            微信进入 / 授权
          </a>
          <p>首次微信进入会选择身份；绑定后同一个微信会直接进入对应端。</p>
        </div>
        <div className="auth-divider">
          <span>或使用手机号密码</span>
        </div>

        <form className="form-grid" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="phone">手机号</label>
            <input
              id="phone"
              inputMode="numeric"
              maxLength={11}
              placeholder="请输入 11 位大陆手机号"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          </div>

          {mode === "register" ? (
            <>
              <div className="field">
                <label htmlFor="realName">真实姓名</label>
                <input
                  id="realName"
                  placeholder="请输入采集员姓名"
                  value={realName}
                  onChange={(event) => setRealName(event.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="teamCode">团长码</label>
                <input
                  id="teamCode"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="请输入 6 位团长码"
                  value={teamCode}
                  onChange={(event) => setTeamCode(event.target.value)}
                />
              </div>
            </>
          ) : null}

          <div className="field">
            <label htmlFor="password">密码</label>
            <input
              id="password"
              minLength={6}
              placeholder={mode === "register" ? "至少 6 位，注册后用于登录" : "请输入密码"}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {mode === "register" ? (
            <div className="field">
              <label htmlFor="confirmPassword">确认密码</label>
              <input
                id="confirmPassword"
                minLength={6}
                placeholder="请再次输入密码"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </div>
          ) : null}

          <div className="field field-full agreement-card">
            <div className="agreement-copy">
              <p className="eyebrow">Legal Notice</p>
              <h3>{legalDeclarationTitle}</h3>
              <p>
                请在上传视频或提交数据前仔细阅读声明。点击“查看详情并同意”后，才可以继续登录、注册或提交采集数据。
              </p>
            </div>
            <div className="agreement-check">
              <input
                checked={agreementAccepted}
                onChange={(event) => handleAgreementToggle(event.target.checked)}
                type="checkbox"
              />
              <span>
                {agreementHint}
                <button className="agreement-text-button" onClick={() => setAgreementDialogOpen(true)} type="button">
                  查看详情并同意
                </button>
              </span>
            </div>
          </div>

          <div className="field field-full">
            <button className="submit-button" disabled={submitting} type="submit">
              {submitting ? "提交中..." : mode === "register" ? "注册并进入采集员端" : "登录"}
            </button>
          </div>
        </form>

        {message ? (
          <p aria-live="polite" className="auth-message">
            {message}
          </p>
        ) : null}
      </section>
      {renderAgreementDialog()}
    </main>
  );
}
