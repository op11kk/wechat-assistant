"use client";

import { useState, type FormEvent } from "react";

import type { DomesticLeaderCollectorRow } from "@/lib/domestic-mvp";

type ActionResponse = {
  ok: boolean;
  detail?: string;
  error?: string;
};

async function parseActionResponse(response: Response): Promise<ActionResponse> {
  const text = await response.text();
  if (!text.trim()) {
    return { ok: false, detail: `服务端返回空响应（HTTP ${response.status}）。` };
  }
  try {
    return JSON.parse(text) as ActionResponse;
  } catch {
    return { ok: false, detail: `服务端返回非 JSON 响应（HTTP ${response.status}）。` };
  }
}

async function requestJson(path: string, method: "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>) {
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return parseActionResponse(response);
}

function formValue(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}

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

export default function LeaderManageClient({ collectors }: { collectors: DomesticLeaderCollectorRow[] }) {
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function runAction(action: () => Promise<ActionResponse>) {
    setSubmitting(true);
    setMessage("");
    try {
      const result = await action();
      if (!result.ok) {
        setMessage(result.detail || result.error || "操作失败。");
        return;
      }
      setMessage("操作成功，正在刷新页面...");
      window.setTimeout(() => window.location.reload(), 500);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "网络异常，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  function createCollector(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void runAction(() =>
      requestJson("/api/leader/domestic/collectors", "POST", {
        phone: formValue(form, "phone"),
        real_name: formValue(form, "real_name"),
        collector_code: formValue(form, "collector_code"),
      }),
    );
  }

  function updateCollector(event: FormEvent<HTMLFormElement>, participantId: number) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void runAction(() =>
      requestJson(`/api/leader/domestic/collectors/${participantId}`, "PATCH", {
        phone: formValue(form, "phone"),
        real_name: formValue(form, "real_name"),
        status: formValue(form, "status"),
      }),
    );
  }

  function archiveCollector(participantId: number) {
    if (!window.confirm("确认停用这个采集员？历史视频会保留。")) {
      return;
    }
    void runAction(() => requestJson(`/api/leader/domestic/collectors/${participantId}`, "DELETE"));
  }

  return (
    <section className="status-panel dashboard-panel">
      <div className="dashboard-header">
        <div>
          <p className="eyebrow">Team CRUD</p>
          <h2>团队采集员维护</h2>
        </div>
        <p className="dashboard-hint">团长只能新增、修改、停用自己团队内的采集员。</p>
      </div>

      <form className="form-grid compact-form" onSubmit={createCollector}>
        <div className="field">
          <label htmlFor="leaderCollectorPhone">手机号</label>
          <input id="leaderCollectorPhone" name="phone" inputMode="numeric" maxLength={11} placeholder="13900000011" />
        </div>
        <div className="field">
          <label htmlFor="leaderCollectorName">姓名</label>
          <input id="leaderCollectorName" name="real_name" placeholder="采集员姓名" />
        </div>
        <div className="field">
          <label htmlFor="leaderCollectorCode">采集员编号</label>
          <input id="leaderCollectorCode" name="collector_code" inputMode="numeric" maxLength={6} placeholder="留空自动生成" />
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <button className="submit-button" disabled={submitting} type="submit">
            新增采集员
          </button>
        </div>
      </form>

      {message ? <p className="auth-message manage-message">{message}</p> : null}

      <div className="table-wrap leader-crud-table">
        <table className="dashboard-table manage-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>编号</th>
              <th>姓名</th>
              <th>手机号</th>
              <th>状态</th>
              <th>上传</th>
              <th>待审</th>
              <th>通过</th>
              <th>最近上传</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {collectors.map((collector) => (
              <tr key={collector.participantId}>
                <td>{collector.participantId}</td>
                <td>{collector.participantCode}</td>
                <td>{collector.realName}</td>
                <td>{collector.phone}</td>
                <td>{collector.status}</td>
                <td>{collector.submissionCount}</td>
                <td>{collector.pendingCount}</td>
                <td>{collector.approvedCount}</td>
                <td>{formatDateTime(collector.latestSubmittedAt)}</td>
                <td>
                  <form className="inline-edit-form leader-collector-edit-form" onSubmit={(event) => updateCollector(event, collector.participantId)}>
                    <input name="real_name" defaultValue={collector.realName} placeholder="姓名" />
                    <input name="phone" defaultValue={collector.phone} placeholder="手机号" />
                    <select name="status" defaultValue={collector.status}>
                      <option value="active">active</option>
                      <option value="paused">paused</option>
                      <option value="withdrawn">withdrawn</option>
                    </select>
                    <button className="secondary-link inline-action" disabled={submitting} type="submit">
                      保存
                    </button>
                    <button
                      className="secondary-link inline-action danger-link"
                      disabled={submitting}
                      onClick={() => archiveCollector(collector.participantId)}
                      type="button"
                    >
                      停用
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
