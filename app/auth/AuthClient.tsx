"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

type Mode = "login" | "register";

type AuthResponse = {
  ok: boolean;
  detail?: string;
  redirect_path?: string;
  debugCode?: string;
  debug_code?: string;
};

type AuthClientProps = {
  initialMode?: Mode;
  lockMode?: boolean;
};

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

export default function AuthClient({ initialMode = "register", lockMode = false }: AuthClientProps) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [realName, setRealName] = useState("");
  const [agreementAccepted, setAgreementAccepted] = useState(false);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);

  const agreementHint = useMemo(() => {
    if (mode === "register") {
      return "采集员注册前必须勾选并同意法律协议。";
    }
    return "采集员和团长登录前必须勾选并同意法律协议，管理员账号可跳过。";
  }, [mode]);

  async function handleSendCode() {
    setSendingCode(true);
    setMessage("");

    try {
      const result = await postJson("/api/auth/send-code", {
        phone,
        purpose: mode,
      });

      if (!result.ok) {
        setMessage(result.detail || "验证码发送失败，请稍后重试。");
        return;
      }

      const debugCode = result.debug_code || result.debugCode;
      setMessage(
        debugCode
          ? `验证码已生成，开发环境调试码：${debugCode}`
          : "验证码已发送，请查收短信。",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "验证码发送失败，请稍后重试。");
    } finally {
      setSendingCode(false);
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage("");

    try {
      const payload =
        mode === "register"
          ? {
              phone,
              code,
              display_name: displayName || null,
              real_name: realName || null,
              agreement_accepted: agreementAccepted,
            }
          : {
              phone,
              code,
              agreement_accepted: agreementAccepted,
            };

      const result = await postJson(mode === "register" ? "/api/auth/register" : "/api/auth/login", payload);
      if (!result.ok) {
        setMessage(result.detail || "请求失败，请稍后重试。");
        return;
      }

      setMessage(mode === "register" ? "注册成功，正在跳转..." : "登录成功，正在跳转...");
      window.setTimeout(() => {
        window.location.href = result.redirect_path || "/";
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
        <p className="eyebrow">Domestic Auth</p>
        <h1>手机号注册 / 登录</h1>
        <p className="hero-copy">
          国内版 MVP 当前采用验证码注册与登录流程。开发环境会直接回显调试验证码，后续接入短信平台后可替换成真实短信发送。
        </p>
      </section>

      <section className="upload-panel auth-panel">
        {lockMode ? (
          <div className="auth-toggle">
            <span className="primary-link">{mode === "register" ? "注册" : "登录"}</span>
            <Link className="secondary-link" href={mode === "register" ? "/login" : "/register"}>
              {mode === "register" ? "已有账号，去登录" : "没有账号，去注册"}
            </Link>
          </div>
        ) : (
          <div className="auth-toggle">
          <button
            type="button"
            className={mode === "register" ? "primary-link" : "secondary-link"}
            onClick={() => setMode("register")}
          >
            注册
          </button>
          <button
            type="button"
            className={mode === "login" ? "primary-link" : "secondary-link"}
            onClick={() => setMode("login")}
          >
            登录
          </button>
          </div>
        )}

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

          <div className="field">
            <label htmlFor="code">验证码</label>
            <div className="inline-field">
              <input
                id="code"
                inputMode="numeric"
                maxLength={6}
                placeholder="请输入 6 位验证码"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <button
                className="secondary-link inline-action"
                disabled={sendingCode}
                onClick={handleSendCode}
                type="button"
              >
                {sendingCode ? "发送中..." : "获取验证码"}
              </button>
            </div>
          </div>

          {mode === "register" ? (
            <>
              <div className="field">
                <label htmlFor="displayName">显示名称</label>
                <input
                  id="displayName"
                  placeholder="例如：采集员001"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="realName">真实姓名</label>
                <input
                  id="realName"
                  placeholder="协议内容确定后可再补完整实名要求"
                  value={realName}
                  onChange={(event) => setRealName(event.target.value)}
                />
              </div>
            </>
          ) : null}

          <div className="field field-full agreement-card">
            <div className="agreement-copy">
              <p className="eyebrow">Legal Placeholder</p>
              <h3>法律协议占位内容</h3>
              <p>
                这里后面会替换成正式的《用户服务协议》《隐私政策》以及与你的视频采集业务相关的授权条款。
                当前先按占位版本接入流程，确保采集员端和团长端登录前必须显式同意。
              </p>
            </div>
            <label className="agreement-check">
              <input
                checked={agreementAccepted}
                onChange={(event) => setAgreementAccepted(event.target.checked)}
                type="checkbox"
              />
              <span>{agreementHint}</span>
            </label>
          </div>

          <div className="field field-full">
            <button className="submit-button" disabled={submitting} type="submit">
              {submitting ? "提交中..." : mode === "register" ? "手机号注册" : "验证码登录"}
            </button>
          </div>
        </form>

        {message ? <p className="auth-message">{message}</p> : null}
      </section>
    </main>
  );
}
