"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { encodeSubmissionMeta, type H5UploadKind } from "@/lib/h5-workflow";
import { DEFAULT_MULTIPART_CONCURRENCY } from "@/lib/upload-multipart";

type LogLine = {
  type: "info" | "error" | "success";
  text: string;
};

type MultipartInitResponse = {
  session_id: string;
  participant_code: string;
  object_key: string;
  object_url: string | null;
  upload_id: string;
  part_size: number;
  part_count: number;
  concurrency: number;
  storage: string;
};

type UploadSessionResponse = {
  session_id: string;
  status: "uploading" | "completed" | "aborted" | "expired" | "failed";
  object_key: string;
  file_name: string | null;
  size_bytes: number | null;
  mime: string | null;
  part_size: number;
  part_count: number;
  uploaded_parts: Array<{ part_number: number; etag: string }>;
  user_comment: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type PartPresignResponse = {
  url: string;
  part_number: number;
  upload_id: string;
  object_key: string;
  headers?: Record<string, string>;
};

type StoredMultipartSession = {
  sessionId: string;
  participantCode: string;
  fileName: string;
  sizeBytes: number;
  mime: string;
  objectKey: string;
  partSize: number;
  partCount: number;
  uploadKind: H5UploadKind;
  scene: string;
  updatedAt: string;
};

type SubmissionSummary = {
  id: number;
  file_name: string | null;
  object_url: string | null;
  review_status: "pending" | "approved" | "rejected";
  reject_reason: string | null;
  created_at: string;
  submission_kind: H5UploadKind | null;
  submission_kind_label: string;
  scene: string | null;
  note: string | null;
};

type WorkflowSummary = {
  consent_confirmed: boolean;
  test_status: "not_started" | "pending" | "passed" | "failed";
  formal_status: "not_started" | "pending" | "reviewed";
  stage:
    | "new_unconfirmed"
    | "test_pending_start"
    | "test_uploaded_pending_review"
    | "test_failed"
    | "formal_available"
    | "formal_uploaded_pending_review";
  current_upload_kind: H5UploadKind | null;
  current_title: string;
  current_description: string;
  can_upload: boolean;
  tips: string[];
};

type ParticipantLookupResponse = {
  participant: {
    id: number;
    participant_code: string;
    status: string;
    display_name: string;
    display_phone: string;
  };
  workflow: WorkflowSummary;
  scenes: Array<{
    name: string;
    remaining_text: string;
    description: string;
  }>;
  submissions: SubmissionSummary[];
};

const STORAGE_KEY = "h5-multipart-session-v2";
const MAX_RETRIES_PER_PART = 3;

function formatLogValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function readStoredSession(): StoredMultipartSession | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as StoredMultipartSession;
    if (!parsed?.sessionId || !parsed.fileName || !parsed.participantCode || !parsed.uploadKind || !parsed.scene) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function writeStoredSession(session: StoredMultipartSession | null) {
  if (typeof window === "undefined") {
    return;
  }

  if (!session) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

async function readJsonOrText(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text || response.statusText;
  }
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const detail = await readJsonOrText(response);
    throw new Error(formatLogValue(detail));
  }
  return (await response.json()) as T;
}

function formatBytes(sizeBytes: number | null | undefined): string {
  if (!sizeBytes || sizeBytes <= 0) {
    return "-";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = sizeBytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(
    2,
    "0",
  )} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function getReviewLabel(status: SubmissionSummary["review_status"]): string {
  if (status === "approved") {
    return "审核通过";
  }
  if (status === "rejected") {
    return "未通过";
  }
  return "待审核";
}

function getStageLabel(stage: WorkflowSummary["stage"]): string {
  if (stage === "formal_available") {
    return "正式任务";
  }
  if (stage === "formal_uploaded_pending_review") {
    return "正式任务审核中";
  }
  if (stage === "test_failed") {
    return "重新测试";
  }
  if (stage === "test_uploaded_pending_review") {
    return "测试审核中";
  }
  if (stage === "new_unconfirmed") {
    return "待确认";
  }
  return "测试阶段";
}

function getUploadButtonLabel(kind: H5UploadKind, canResumeCurrentFile: boolean, isUploading: boolean): string {
  if (isUploading) {
    return "正在上传，请稍候";
  }
  if (canResumeCurrentFile) {
    return kind === "test" ? "继续上传测试视频" : "继续上传正式视频";
  }
  return kind === "test" ? "提交测试视频" : "提交正式视频";
}

function slicePart(file: File, partSize: number, partNumber: number): Blob {
  const start = (partNumber - 1) * partSize;
  const end = Math.min(start + partSize, file.size);
  return file.slice(start, end);
}

function getPartBytes(fileSize: number, partSize: number, partNumber: number): number {
  const start = (partNumber - 1) * partSize;
  const end = Math.min(start + partSize, fileSize);
  return Math.max(end - start, 0);
}

function uploadPartWithProgress(
  url: string,
  blob: Blob,
  headers: Record<string, string>,
  onProgress: (loadedBytes: number) => void,
) {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        return;
      }
      onProgress(event.loaded);
    };

    xhr.onerror = () => {
      reject(new Error("上传过程中网络异常，请检查网络后重试。"));
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader("ETag")?.trim();
        if (!etag) {
          reject(new Error("文件已传到云端，但系统没有拿到回执，请稍后重试。"));
          return;
        }

        onProgress(blob.size);
        resolve(etag);
        return;
      }

      reject(new Error(`上传失败：HTTP ${xhr.status}`));
    };

    xhr.send(blob);
  });
}

function buildStatusSummary(params: {
  workflow: WorkflowSummary | null;
  progress: number;
  isUploading: boolean;
  latestLog: LogLine | null;
}) {
  if (params.isUploading) {
    return `正在上传中，当前进度 ${params.progress}%。请保持页面停留在前台，不要关闭页面。`;
  }

  if (params.latestLog?.type === "success") {
    return "视频已提交成功，系统会尽快完成审核。";
  }

  if (params.latestLog?.type === "error") {
    return params.latestLog.text;
  }

  if (!params.workflow) {
    return "请输入公众号里收到的 6 位上传码，验证后即可进入对应任务。";
  }

  return params.workflow.current_description;
}

export default function H5UploadClient() {
  const searchParams = useSearchParams();
  const [participantCodeInput, setParticipantCodeInput] = useState("");
  const [viewer, setViewer] = useState<ParticipantLookupResponse | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [comment, setComment] = useState("");
  const [scene, setScene] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [storedSession, setStoredSession] = useState<StoredMultipartSession | null>(null);

  const latestLog = logs.length > 0 ? logs[logs.length - 1] : null;

  const appendLog = (type: LogLine["type"], value: unknown) => {
    setLogs((current) => [...current, { type, text: formatLogValue(value) }]);
  };

  const syncStoredSession = (session: StoredMultipartSession | null) => {
    setStoredSession(session);
    writeStoredSession(session);
  };

  const clearStoredSession = () => {
    syncStoredSession(null);
  };

  const loadParticipantByCode = async (code: string) => {
    const normalizedCode = code.trim();
    if (!normalizedCode) {
      setViewer(null);
      setViewerError("请先输入 6 位上传码。");
      return;
    }

    setIsLookingUp(true);
    setViewerError(null);

    try {
      const nextViewer = await fetchJson<ParticipantLookupResponse>(
        `/api/h5/code/${encodeURIComponent(normalizedCode)}`,
      );
      setViewer(nextViewer);
      setParticipantCodeInput(nextViewer.participant.participant_code);
      const nextScene = nextViewer.scenes[0]?.name ?? "";
      setScene((current) =>
        current && nextViewer.scenes.some((item) => item.name === current) ? current : nextScene,
      );
    } catch (error) {
      setViewer(null);
      setViewerError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLookingUp(false);
    }
  };

  useEffect(() => {
    const codeFromQuery = searchParams.get("code")?.trim() ?? "";
    const nextStored = readStoredSession();
    setStoredSession(nextStored);

    const initialCode = codeFromQuery || nextStored?.participantCode || "";
    if (!initialCode) {
      return;
    }

    setParticipantCodeInput(initialCode);
    void loadParticipantByCode(initialCode);
  }, [searchParams]);

  const resolvedParticipantCode = viewer?.participant.participant_code ?? participantCodeInput.trim();
  const activeUploadKind = viewer?.workflow.current_upload_kind ?? "test";
  const canUpload = Boolean(viewer?.workflow.can_upload && viewer?.participant);

  const canResumeCurrentFile =
    Boolean(storedSession) &&
    Boolean(file) &&
    Boolean(resolvedParticipantCode) &&
    storedSession?.participantCode === resolvedParticipantCode &&
    storedSession?.fileName === file?.name &&
    storedSession?.sizeBytes === file?.size &&
    storedSession?.scene === scene &&
    storedSession?.uploadKind === activeUploadKind;

  const visibleLogs = useMemo(() => logs.slice(-6), [logs]);
  const selectedSceneMeta = viewer?.scenes.find((item) => item.name === scene) ?? null;

  const handleSubmit = async () => {
    setLogs([]);
    setProgress(0);

    if (!viewer?.participant || !viewer.workflow) {
      appendLog("error", "请先输入上传码并完成验证。");
      return;
    }

    if (!viewer.workflow.can_upload) {
      appendLog("error", "当前状态还不能上传，请先按页面提示完成前置步骤。");
      return;
    }

    if (!scene) {
      appendLog("error", "请先选择拍摄场景。");
      return;
    }

    if (!file) {
      appendLog("error", "请先选择视频文件。");
      return;
    }

    setIsUploading(true);
    const selectedFile = file;
    const contentType = selectedFile.type || "video/mp4";
    const progressByPart = new Map<number, number>();
    const structuredComment = encodeSubmissionMeta({
      kind: activeUploadKind,
      scene,
      note: comment.trim() || null,
    });

    try {
      let sessionState: UploadSessionResponse;
      let sessionSnapshot: StoredMultipartSession;

      if (canResumeCurrentFile && storedSession) {
        appendLog("info", "已找到未完成上传，正在继续上传。");
        sessionState = await fetchJson<UploadSessionResponse>(`/upload/multipart/session/${storedSession.sessionId}`);
        sessionSnapshot = {
          sessionId: sessionState.session_id,
          participantCode: viewer.participant.participant_code,
          fileName: selectedFile.name,
          sizeBytes: selectedFile.size,
          mime: contentType,
          objectKey: sessionState.object_key,
          partSize: sessionState.part_size,
          partCount: sessionState.part_count,
          uploadKind: activeUploadKind,
          scene,
          updatedAt: new Date().toISOString(),
        };
        syncStoredSession(sessionSnapshot);
      } else {
        appendLog("info", "正在创建上传任务。");
        const init = await fetchJson<MultipartInitResponse>("/upload/multipart/init", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            participant_code: viewer.participant.participant_code,
            content_type: contentType,
            file_name: selectedFile.name,
            size_bytes: selectedFile.size,
            user_comment: structuredComment,
          }),
        });

        sessionSnapshot = {
          sessionId: init.session_id,
          participantCode: init.participant_code,
          fileName: selectedFile.name,
          sizeBytes: selectedFile.size,
          mime: contentType,
          objectKey: init.object_key,
          partSize: init.part_size,
          partCount: init.part_count,
          uploadKind: activeUploadKind,
          scene,
          updatedAt: new Date().toISOString(),
        };
        syncStoredSession(sessionSnapshot);

        sessionState = {
          session_id: init.session_id,
          status: "uploading",
          object_key: init.object_key,
          file_name: selectedFile.name,
          size_bytes: selectedFile.size,
          mime: contentType,
          part_size: init.part_size,
          part_count: init.part_count,
          uploaded_parts: [],
          user_comment: structuredComment,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: null,
        };
      }

      if (sessionState.status !== "uploading") {
        throw new Error(`当前上传状态为 ${sessionState.status}，请重新开始。`);
      }

      const uploadedParts = new Map<number, string>(
        sessionState.uploaded_parts.map((part) => [part.part_number, part.etag]),
      );

      const updateOverallProgress = () => {
        let uploadedBytes = 0;

        for (const partNumber of uploadedParts.keys()) {
          uploadedBytes += getPartBytes(selectedFile.size, sessionState.part_size, partNumber);
        }

        for (const [partNumber, loadedBytes] of progressByPart.entries()) {
          if (uploadedParts.has(partNumber)) {
            continue;
          }
          uploadedBytes += loadedBytes;
        }

        const nextProgress = Math.min(100, Math.round((uploadedBytes / selectedFile.size) * 100));
        setProgress(nextProgress);
      };

      updateOverallProgress();

      const pendingPartNumbers: number[] = [];
      for (let partNumber = 1; partNumber <= sessionState.part_count; partNumber += 1) {
        if (!uploadedParts.has(partNumber)) {
          pendingPartNumbers.push(partNumber);
        }
      }

      appendLog("info", `视频已切分为 ${sessionState.part_count} 段，正在开始上传。`);

      const concurrency = Math.min(DEFAULT_MULTIPART_CONCURRENCY, Math.max(pendingPartNumbers.length, 1));
      const queue = [...pendingPartNumbers];

      const uploadSinglePart = async (partNumber: number) => {
        const blob = slicePart(selectedFile, sessionState.part_size, partNumber);
        let lastError: unknown = null;

        for (let attempt = 1; attempt <= MAX_RETRIES_PER_PART; attempt += 1) {
          try {
            const presign = await fetchJson<PartPresignResponse>("/upload/multipart/part", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                session_id: sessionState.session_id,
                part_number: partNumber,
              }),
            });

            progressByPart.set(partNumber, 0);
            updateOverallProgress();

            const etag = await uploadPartWithProgress(presign.url, blob, presign.headers ?? {}, (loadedBytes) => {
              progressByPart.set(partNumber, loadedBytes);
              updateOverallProgress();
            });

            progressByPart.delete(partNumber);
            uploadedParts.set(partNumber, etag);

            await fetchJson("/upload/multipart/part", {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                session_id: sessionState.session_id,
                part_number: partNumber,
                etag,
              }),
            });

            sessionSnapshot = {
              ...sessionSnapshot,
              updatedAt: new Date().toISOString(),
            };
            syncStoredSession(sessionSnapshot);
            updateOverallProgress();
            return;
          } catch (error) {
            lastError = error;
            progressByPart.delete(partNumber);
            updateOverallProgress();

            if (attempt < MAX_RETRIES_PER_PART) {
              appendLog("error", `上传中断，正在进行第 ${attempt + 1} 次重试。`);
            }
          }
        }

        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      };

      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (queue.length > 0) {
            const current = queue.shift();
            if (!current) {
              return;
            }
            await uploadSinglePart(current);
          }
        }),
      );

      appendLog("info", "视频已上传完成，正在提交审核。");

      const parts = Array.from(uploadedParts.entries())
        .sort(([a], [b]) => a - b)
        .map(([part_number, etag]) => ({ part_number, etag }));

      await fetchJson("/upload/multipart/complete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: sessionState.session_id,
          parts,
          user_comment: structuredComment,
        }),
      });

      setProgress(100);
      appendLog(
        "success",
        activeUploadKind === "test"
          ? "测试视频已上传成功，请等待审核结果。"
          : "正式视频已上传成功，系统会尽快审核。",
      );
      clearStoredSession();
      setFile(null);
      setComment("");
      await loadParticipantByCode(viewer.participant.participant_code);
    } catch (error) {
      appendLog("error", error instanceof Error ? error.message : String(error));
    } finally {
      setIsUploading(false);
    }
  };

  const handleAbortStoredSession = async () => {
    if (!storedSession) {
      return;
    }

    try {
      await fetchJson(`/upload/multipart/session/${storedSession.sessionId}`, {
        method: "DELETE",
      });
      appendLog("info", "已放弃上一次未完成上传。");
    } catch (error) {
      appendLog("error", error instanceof Error ? error.message : String(error));
    } finally {
      clearStoredSession();
    }
  };

  const summaryText = buildStatusSummary({
    workflow: viewer?.workflow ?? null,
    progress,
    isUploading,
    latestLog,
  });

  return (
    <main className="upload-shell">
      <section className="upload-panel">
        <header className="upload-header">
          <p className="eyebrow">WeChat H5 Upload</p>
          <h1>欢迎参与视频采集</h1>
          <p>
            本页面用于提交测试视频和正式任务视频。
            系统会根据你的当前状态，自动显示你现在应该完成的任务。
          </p>
        </header>

        <div className="status-panel feature-panel" style={{ marginTop: 24, marginBottom: 16 }}>
          <div className="feature-grid">
            <div className="feature-item">
              <strong>用途说明</strong>
              <p>本次提交内容将用于机器人训练与具身智能算法研发。</p>
            </div>
            <div className="feature-item">
              <strong>上传前提示</strong>
              <p>请先选择场景，再上传对应视频；上传过程中不要关闭页面。</p>
            </div>
            <div className="feature-item">
              <strong>审核规则</strong>
              <p>测试视频仅用于审核拍摄质量，不计收益；正式视频提交后进入审核流程。</p>
            </div>
          </div>
        </div>

        <div className="status-panel" style={{ marginBottom: 16 }}>
          <div className="form-grid" style={{ marginTop: 0 }}>
            <div className="field">
              <label htmlFor="participantCode">上传码</label>
              <input
                id="participantCode"
                inputMode="numeric"
                maxLength={6}
                value={participantCodeInput}
                onChange={(event) => setParticipantCodeInput(event.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="请输入公众号里收到的 6 位上传码"
              />
              <p className="field-hint">如果你是从公众号链接进入，系统通常会自动带入上传码。</p>
            </div>
          </div>
          <div className="submit-row">
            <button
              className="submit-button"
              disabled={isLookingUp || participantCodeInput.trim().length === 0}
              onClick={() => void loadParticipantByCode(participantCodeInput)}
              type="button"
            >
              {isLookingUp ? "正在验证" : "确认上传码"}
            </button>
          </div>
          {viewerError ? <p className="field-hint" style={{ marginTop: 14 }}>{viewerError}</p> : null}
        </div>

        {viewer?.participant ? (
          <div className="status-panel" style={{ marginBottom: 16 }}>
            <div className="status-row">
              <div className="status-chip">账号 {viewer.participant.participant_code}</div>
              <div className="status-chip">当前阶段 {getStageLabel(viewer.workflow.stage)}</div>
            </div>
            <p className="field-hint">
              当前用户：{viewer.participant.display_name} / {viewer.participant.display_phone}
            </p>
            <div className="callout-box">
              <strong>{viewer.workflow.current_title}</strong>
              <p>{summaryText}</p>
            </div>
          </div>
        ) : null}

        {storedSession ? (
          <div className="status-panel" style={{ marginBottom: 16 }}>
            <div className="status-row">
              <div className="status-chip">发现未完成上传</div>
              <div className="status-chip">{storedSession.uploadKind === "test" ? "测试视频" : "正式任务"}</div>
            </div>
            <p className="field-hint">
              文件：{storedSession.fileName}，场景：{storedSession.scene}，最近更新：{formatDate(storedSession.updatedAt)}
            </p>
            <div className="submit-row">
              <button className="submit-button" onClick={handleAbortStoredSession} type="button">
                放弃上次上传
              </button>
            </div>
          </div>
        ) : null}

        {viewer?.workflow ? (
          <div className="status-panel" style={{ marginBottom: 16 }}>
            <div className="status-row">
              <div className="status-chip">
                当前任务：{activeUploadKind === "test" ? "测试视频" : "正式任务视频"}
              </div>
            </div>

            <div className="tips-list">
              {viewer.workflow.tips.map((tip) => (
                <p className="tip-item" key={tip}>
                  {tip}
                </p>
              ))}
            </div>

            <div className="form-grid" style={{ marginTop: 20 }}>
              <div className="field">
                <label htmlFor="scene">拍摄场景</label>
                <select id="scene" value={scene} onChange={(event) => setScene(event.target.value)}>
                  <option value="">请选择场景</option>
                  {viewer.scenes.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name} {item.remaining_text ? `（${item.remaining_text}）` : ""}
                    </option>
                  ))}
                </select>
                <p className="field-hint">当前展示的是演示名额，例如 7/50，后面可以再接真实数据库配额。</p>
                {selectedSceneMeta ? (
                  <div className="scene-selected">
                    <strong>{selectedSceneMeta.name}</strong>
                    <p>{selectedSceneMeta.description}</p>
                  </div>
                ) : null}
              </div>

              <div className="field">
                <label htmlFor="file">上传视频</label>
                <input
                  id="file"
                  type="file"
                  accept="video/*"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
                {file ? <small>已选择：{file.name}（{formatBytes(file.size)}）</small> : null}
              </div>

              <div className="field field-full">
                <label htmlFor="comment">补充说明</label>
                <textarea
                  id="comment"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="可选，例如拍摄时的特殊说明。"
                />
              </div>
            </div>

            <div className="scene-guide">
              {viewer.scenes.map((item) => (
                <article className="scene-card" key={item.name}>
                  <div className="status-row">
                    <strong>{item.name}</strong>
                    <span className="status-chip">{item.remaining_text}</span>
                  </div>
                  <p>{item.description}</p>
                </article>
              ))}
            </div>

            <div className="progress-stack">
              <div className="status-row">
                <div className="progress-chip">上传进度 {progress}%</div>
                <div className="status-chip">{canResumeCurrentFile ? "支持继续上传" : "新上传任务"}</div>
              </div>
              <div aria-hidden="true" className="progress-track">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
            </div>

            <div className="submit-row">
              <button
                className="submit-button"
                disabled={isUploading || !canUpload}
                onClick={handleSubmit}
                type="button"
              >
                {getUploadButtonLabel(activeUploadKind, canResumeCurrentFile, isUploading)}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {viewer?.submissions?.length ? (
        <section className="status-panel">
          <div className="status-chip">我的提交记录</div>
          <div className="submission-list">
            {viewer.submissions.map((submission) => (
              <article className="submission-card" key={submission.id}>
                <div className="status-row">
                  <strong>{submission.file_name || `视频 #${submission.id}`}</strong>
                  <span className="status-chip">{submission.submission_kind_label}</span>
                  <span className="status-chip">{getReviewLabel(submission.review_status)}</span>
                </div>
                <p className="field-hint">场景：{submission.scene || "未记录"}</p>
                <p className="field-hint">提交时间：{formatDate(submission.created_at)}</p>
                {submission.note ? <p className="field-hint">补充说明：{submission.note}</p> : null}
                {submission.reject_reason ? <p className="field-hint">未通过原因：{submission.reject_reason}</p> : null}
                {submission.object_url ? (
                  <div className="submit-row">
                    <a className="secondary-link" href={submission.object_url} rel="noreferrer" target="_blank">
                      查看视频
                    </a>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="status-panel">
        <details className="log-details">
          <summary>查看上传进度记录</summary>
          <pre className="status-log">
            {visibleLogs.length === 0
              ? "暂时还没有上传记录。"
              : visibleLogs.map((line, index) => (
                  <span
                    className={line.type === "error" ? "error-line" : line.type === "success" ? "success-line" : ""}
                    key={`${line.type}-${index}`}
                  >
                    {line.text}
                    {"\n"}
                  </span>
                ))}
          </pre>
        </details>
      </section>
    </main>
  );
}
