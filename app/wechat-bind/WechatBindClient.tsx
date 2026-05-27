"use client";

import { useState, type FormEvent } from "react";

import { legalDeclarationParagraphs, legalDeclarationTitle } from "@/lib/legal-declaration";

type BindMode = "collector_signup" | "existing_account";

type BindResponse = {
  ok: boolean;
  detail?: string;
  error?: string;
  redirect_path?: string;
  redirectPath?: string;
};

type WechatBindClientProps = {
  initialTeamCode?: string;
  openidPreview: string;
};

async function parseBindResponse(response: Response): Promise<BindResponse> {
  const text = await response.text();
  if (!text.trim()) {
    return { ok: false, detail: `服务端返回空响应（HTTP ${response.status}）。` };
  }
  try {
    return JSON.parse(text) as BindResponse;
  } catch {
    return { ok: false, detail: `服务端返回了非 JSON 响应（HTTP ${response.status}）。` };
  }
}

function getRedirectPath(result: BindResponse): string {
  return result.redirect_path || result.redirectPath || "/collector";
}

export default function WechatBindClient({ initialTeamCode = "", openidPreview }: WechatBindClientProps) {
  const [bindMode, setBindMode] = useState<BindMode>("collector_signup");
  const [realName, setRealName] = useState("");
  const [teamCode, setTeamCode] = useState(initialTeamCode);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [existingPhone, setExistingPhone] = useState("");
  const [existingPassword, setExistingPassword] = useState("");
  const [agreementAccepted, setAgreementAccepted] = useState(false);
  const [agreementDialogOpen, setAgreementDialogOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

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

  function switchBindMode(nextMode: BindMode) {
    setBindMode(nextMode);
    setMessage("");
  }

  function renderAgreementDialog() {
    if (!agreementDialogOpen) {
      return null;
    }

    return (
      <div className="agreement-modal-backdrop" role="presentation">
        <section
          aria-labelledby="wechatAgreementDialogTitle"
          aria-modal="true"
          className="agreement-modal"
          role="dialog"
        >
          <div className="agreement-modal-header">
            <div>
              <p className="eyebrow">Legal Notice</p>
              <h2 id="wechatAgreementDialogTitle">{legalDeclarationTitle}</h2>
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

    setSubmitting(true);
    try {
      const body =
        bindMode === "existing_account"
          ? {
              bind_mode: "existing_account",
              phone: existingPhone,
              password: existingPassword,
              agreement_accepted: agreementAccepted,
            }
          : {
              bind_mode: "collector_signup",
              real_name: realName,
              display_name: realName,
              team_code: teamCode,
              phone,
              password,
              agreement_accepted: agreementAccepted,
            };

      const response = await fetch("/api/auth/wechat/bind", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const result = await parseBindResponse(response);
      if (!result.ok) {
        setMessage(result.detail || result.error || "绑定失败，请稍后重试。");
        return;
      }
      setMessage("绑定成功，正在进入对应后台...");
      window.setTimeout(() => {
        window.location.href = getRedirectPath(result);
      }, 400);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "网络异常，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="landing-shell">
      <section className="hero-panel">
        <p className="eyebrow">Wechat OAuth</p>
        <h1>绑定微信身份</h1>
        <p className="hero-copy">
          微信授权已完成，当前身份为 <code>{openidPreview}</code>。请选择这次微信要绑定到采集员，还是绑定到已有团长/管理员账号。
        </p>
      </section>

      <section className="upload-panel auth-panel">
        <div className="auth-toggle wechat-bind-toggle">
          <button
            className={bindMode === "collector_signup" ? "primary-link" : "secondary-link"}
            onClick={() => switchBindMode("collector_signup")}
            type="button"
          >
            我是采集员
          </button>
          <button
            className={bindMode === "existing_account" ? "primary-link" : "secondary-link"}
            onClick={() => switchBindMode("existing_account")}
            type="button"
          >
            我是团长/管理员
          </button>
        </div>

        <form className="form-grid" onSubmit={handleSubmit}>
          {bindMode === "collector_signup" ? (
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
                <label className="label-with-hint" htmlFor="teamCode">
                  团长码
                  <span>找邀请你参与采集的人领取</span>
                </label>
                <input
                  id="teamCode"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="请输入 6 位团长码"
                  value={teamCode}
                  onChange={(event) => setTeamCode(event.target.value)}
                />
                <p className="field-hint team-code-hint">
                  团长码就是 6 位邀请码。第一次来平台时，请向邀请你参加采集的人、组织者或项目负责人索要。
                </p>
              </div>

              <div className="field">
                <label htmlFor="phone">手机号</label>
                <input
                  id="phone"
                  inputMode="numeric"
                  maxLength={11}
                  placeholder="可选，作为备用登录和联系"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="password">备用密码</label>
                <input
                  id="password"
                  minLength={6}
                  placeholder="可选，至少 6 位"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label htmlFor="existingPhone">已有账号手机号</label>
                <input
                  id="existingPhone"
                  inputMode="numeric"
                  maxLength={11}
                  placeholder="请输入团长或管理员手机号"
                  value={existingPhone}
                  onChange={(event) => setExistingPhone(event.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="existingPassword">已有账号密码</label>
                <input
                  id="existingPassword"
                  minLength={6}
                  placeholder="请输入账号密码"
                  type="password"
                  value={existingPassword}
                  onChange={(event) => setExistingPassword(event.target.value)}
                />
              </div>

              <div className="field field-full bind-mode-note">
                团长和管理员不能通过微信直接自助创建高权限账号。请先在后台创建好账号，再用这里的手机号和密码把微信绑定到该账号。
              </div>
            </>
          )}

          <div className="field field-full agreement-card">
            <div className="agreement-copy">
              <p className="eyebrow">Legal Notice</p>
              <h3>{legalDeclarationTitle}</h3>
              <p>继续绑定并提交数据，即表示你已阅读、理解并同意平台的数据采集、AI 训练用途和责任声明。</p>
            </div>
            <div className="agreement-check">
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
          </div>

          <div className="field field-full">
            <button className="submit-button" disabled={submitting} type="submit">
              {submitting ? "绑定中..." : bindMode === "existing_account" ? "绑定微信并进入后台" : "绑定微信并进入采集员端"}
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
