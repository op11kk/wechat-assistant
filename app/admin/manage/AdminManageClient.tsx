"use client";

import { useState, type FormEvent } from "react";

import type { DomesticManageData } from "@/lib/domestic-admin";

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

function formValue(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}

export default function AdminManageClient({ data }: { data: DomesticManageData }) {
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

  function submitLeader(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void runAction(() =>
      requestJson("/api/admin/domestic/leaders", "POST", {
        phone: formValue(form, "phone"),
        promoter_name: formValue(form, "promoter_name"),
        promo_code: formValue(form, "promo_code"),
        status: formValue(form, "status") || "active",
        note: formValue(form, "note"),
      }),
    );
  }

  function submitCollector(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void runAction(() =>
      requestJson("/api/admin/domestic/collectors", "POST", {
        phone: formValue(form, "phone"),
        real_name: formValue(form, "real_name"),
        collector_code: formValue(form, "collector_code"),
        leader_id: formValue(form, "leader_id"),
        status: formValue(form, "status") || "active",
      }),
    );
  }

  function updateUser(event: FormEvent<HTMLFormElement>, userId: number) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void runAction(() =>
      requestJson(`/api/admin/domestic/users/${userId}`, "PATCH", {
        role: formValue(form, "role"),
        status: formValue(form, "status"),
        display_name: formValue(form, "display_name"),
        real_name: formValue(form, "real_name"),
      }),
    );
  }

  function disableUser(userId: number) {
    if (!window.confirm("确认停用这个账号？已登录会话也会失效。")) {
      return;
    }
    void runAction(() => requestJson(`/api/admin/domestic/users/${userId}`, "DELETE"));
  }

  function updateLeader(event: FormEvent<HTMLFormElement>, leaderId: number) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void runAction(() =>
      requestJson(`/api/admin/domestic/leaders/${leaderId}`, "PATCH", {
        phone: formValue(form, "phone"),
        promoter_name: formValue(form, "promoter_name"),
        promo_code: formValue(form, "promo_code"),
        status: formValue(form, "status"),
        note: formValue(form, "note"),
      }),
    );
  }

  function disableLeader(leaderId: number) {
    if (!window.confirm("确认停用这个团长团队？团长账号会被停用，历史数据会保留。")) {
      return;
    }
    void runAction(() => requestJson(`/api/admin/domestic/leaders/${leaderId}`, "DELETE"));
  }

  function updateCollector(event: FormEvent<HTMLFormElement>, participantId: number) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void runAction(() =>
      requestJson(`/api/admin/domestic/collectors/${participantId}`, "PATCH", {
        collector_code: formValue(form, "collector_code"),
        real_name: formValue(form, "real_name"),
        phone: formValue(form, "phone"),
        status: formValue(form, "status"),
        leader_id: formValue(form, "leader_id"),
      }),
    );
  }

  function archiveCollector(participantId: number) {
    if (!window.confirm("确认停用这个采集员？历史视频会保留。")) {
      return;
    }
    void runAction(() => requestJson(`/api/admin/domestic/collectors/${participantId}`, "DELETE"));
  }

  return (
    <>
      {message ? <p className="auth-message manage-message">{message}</p> : null}

      <section className="status-panel dashboard-panel">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">Create</p>
            <h2>新增团长和采集员</h2>
          </div>
          <p className="dashboard-hint">这里做日常手动录入：团长会生成团队码，采集员可绑定到某个团长团队。</p>
        </div>

        <div className="split-forms">
          <form className="form-grid compact-form" onSubmit={submitLeader}>
            <div className="field field-full">
              <h3>新增 / 绑定团长</h3>
            </div>
            <div className="field">
              <label htmlFor="leaderPhone">手机号</label>
              <input id="leaderPhone" name="phone" inputMode="numeric" maxLength={11} placeholder="13900000001" />
            </div>
            <div className="field">
              <label htmlFor="leaderName">团长名称</label>
              <input id="leaderName" name="promoter_name" placeholder="测试团长" />
            </div>
            <div className="field">
              <label htmlFor="promoCode">6 位团队码</label>
              <input id="promoCode" name="promo_code" inputMode="numeric" maxLength={6} placeholder="900001" />
            </div>
            <div className="field">
              <label htmlFor="leaderStatus">状态</label>
              <select id="leaderStatus" name="status" defaultValue="active">
                <option value="active">active</option>
                <option value="disabled">disabled</option>
              </select>
            </div>
            <div className="field field-full">
              <label htmlFor="leaderNote">备注</label>
              <input id="leaderNote" name="note" placeholder="可选" />
            </div>
            <div className="field field-full">
              <button className="submit-button" disabled={submitting} type="submit">
                保存团长
              </button>
            </div>
          </form>

          <form className="form-grid compact-form" onSubmit={submitCollector}>
            <div className="field field-full">
              <h3>新增 / 绑定采集员</h3>
            </div>
            <div className="field">
              <label htmlFor="collectorPhone">手机号</label>
              <input id="collectorPhone" name="phone" inputMode="numeric" maxLength={11} placeholder="13900000011" />
            </div>
            <div className="field">
              <label htmlFor="collectorName">姓名</label>
              <input id="collectorName" name="real_name" placeholder="测试采集员" />
            </div>
            <div className="field">
              <label htmlFor="collectorCode">采集员编号</label>
              <input id="collectorCode" name="collector_code" inputMode="numeric" maxLength={6} placeholder="留空自动生成" />
            </div>
            <div className="field">
              <label htmlFor="collectorStatus">状态</label>
              <select id="collectorStatus" name="status" defaultValue="active">
                <option value="active">active</option>
                <option value="paused">paused</option>
                <option value="withdrawn">withdrawn</option>
              </select>
            </div>
            <div className="field field-full">
              <label htmlFor="collectorLeader">所属团长</label>
              <select id="collectorLeader" name="leader_id" defaultValue="">
                <option value="">未绑定</option>
                {data.leaders.map((leader) => (
                  <option key={leader.leaderId} value={leader.leaderId}>
                    {leader.promoterName} / {leader.promoCode}
                  </option>
                ))}
              </select>
            </div>
            <div className="field field-full">
              <button className="submit-button" disabled={submitting} type="submit">
                保存采集员
              </button>
            </div>
          </form>
        </div>
      </section>

      <section className="status-panel dashboard-panel">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">Master Table</p>
            <h2>采集员运营大表</h2>
          </div>
          <p className="dashboard-hint">这张表把采集员、账号、团长归属和上传统计放在一起，日常排查先看这里。</p>
        </div>

        <div className="table-wrap">
          <table className="dashboard-table manage-table wide-manage-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>编号</th>
                <th>姓名</th>
                <th>手机号</th>
                <th>状态</th>
                <th>账号</th>
                <th>团长</th>
                <th>上传数</th>
                <th>最近上传</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.collectors.map((collector) => (
                <tr key={collector.participantId}>
                  <td>{collector.participantId}</td>
                  <td>{collector.participantCode}</td>
                  <td>{collector.realName}</td>
                  <td>{collector.phone}</td>
                  <td>{collector.status}</td>
                  <td>{collector.appUserPhone ?? "-"} / {collector.accountStatus ?? "-"}</td>
                  <td>{collector.leaderName ?? "未绑定"} {collector.leaderPromoCode ? `/${collector.leaderPromoCode}` : ""}</td>
                  <td>{collector.submissionCount}</td>
                  <td>{formatDateTime(collector.latestSubmittedAt)}</td>
                  <td>
                    <form className="inline-edit-form collector-edit-form" onSubmit={(event) => updateCollector(event, collector.participantId)}>
                      <input name="collector_code" defaultValue={collector.participantCode} placeholder="编号" />
                      <input name="real_name" defaultValue={collector.realName} placeholder="姓名" />
                      <input name="phone" defaultValue={collector.phone} placeholder="手机号" />
                      <select name="status" defaultValue={collector.status}>
                        <option value="active">active</option>
                        <option value="paused">paused</option>
                        <option value="withdrawn">withdrawn</option>
                      </select>
                      <select name="leader_id" defaultValue={collector.leaderId ?? ""}>
                        <option value="">未绑定</option>
                        {data.leaders.map((leader) => (
                          <option key={leader.leaderId} value={leader.leaderId}>
                            {leader.promoterName} / {leader.promoCode}
                          </option>
                        ))}
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

      <section className="status-panel dashboard-panel">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">Leaders</p>
            <h2>团长团队表</h2>
          </div>
          <p className="dashboard-hint">可以改团长手机号、团队名、团队码和状态。停用会保留历史数据。</p>
        </div>

        <div className="table-wrap">
          <table className="dashboard-table manage-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>团长</th>
                <th>团队码</th>
                <th>手机号</th>
                <th>状态</th>
                <th>采集员</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.leaders.map((leader) => (
                <tr key={leader.leaderId}>
                  <td>{leader.leaderId}</td>
                  <td>{leader.promoterName}</td>
                  <td>{leader.promoCode}</td>
                  <td>{leader.appUserPhone ?? "-"}</td>
                  <td>{leader.status}</td>
                  <td>{leader.participantCount}</td>
                  <td>
                    <form className="inline-edit-form leader-edit-form" onSubmit={(event) => updateLeader(event, leader.leaderId)}>
                      <input name="phone" defaultValue={leader.appUserPhone ?? ""} placeholder="手机号" />
                      <input name="promoter_name" defaultValue={leader.promoterName} placeholder="团长名称" />
                      <input name="promo_code" defaultValue={leader.promoCode} placeholder="团队码" />
                      <select name="status" defaultValue={leader.status}>
                        <option value="active">active</option>
                        <option value="disabled">disabled</option>
                      </select>
                      <input name="note" defaultValue={leader.note ?? ""} placeholder="备注" />
                      <button className="secondary-link inline-action" disabled={submitting} type="submit">
                        保存
                      </button>
                      <button
                        className="secondary-link inline-action danger-link"
                        disabled={submitting}
                        onClick={() => disableLeader(leader.leaderId)}
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

      <section className="status-panel dashboard-panel">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">Users</p>
            <h2>账号角色表</h2>
          </div>
          <p className="dashboard-hint">这里管理登录账号本身，角色决定能进入管理端、团长端还是采集员端。</p>
        </div>

        <div className="table-wrap">
          <table className="dashboard-table manage-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>手机号</th>
                <th>角色</th>
                <th>状态</th>
                <th>显示名</th>
                <th>实名</th>
                <th>最近登录</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((user) => (
                <tr key={user.id}>
                  <td>{user.id}</td>
                  <td>{user.phone}</td>
                  <td>{user.role}</td>
                  <td>{user.status}</td>
                  <td>{user.displayName ?? "-"}</td>
                  <td>{user.realName ?? "-"}</td>
                  <td>{formatDateTime(user.lastLoginAt)}</td>
                  <td>
                    <form className="inline-edit-form user-edit-form" onSubmit={(event) => updateUser(event, user.id)}>
                      <select name="role" defaultValue={user.role}>
                        <option value="collector">collector</option>
                        <option value="leader">leader</option>
                        <option value="admin">admin</option>
                      </select>
                      <select name="status" defaultValue={user.status}>
                        <option value="pending">pending</option>
                        <option value="active">active</option>
                        <option value="disabled">disabled</option>
                      </select>
                      <input name="display_name" defaultValue={user.displayName ?? ""} placeholder="显示名" />
                      <input name="real_name" defaultValue={user.realName ?? ""} placeholder="实名" />
                      <button className="secondary-link inline-action" disabled={submitting} type="submit">
                        保存
                      </button>
                      <button
                        className="secondary-link inline-action danger-link"
                        disabled={submitting}
                        onClick={() => disableUser(user.id)}
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
    </>
  );
}
