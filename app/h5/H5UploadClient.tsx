"use client";

import { useEffect, useState } from "react";

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
  updatedAt: string;
};

type SubmissionSummary = {
  id: number;
  file_name: string | null;
  object_url: string | null;
  review_status: "pending" | "approved" | "rejected";
  reject_reason: string | null;
  created_at: string;
};

type ParticipantLookupResponse = {
  participant: {
    id: number;
    participant_code: string;
    status: string;
    display_name: string;
    display_phone: string;
  };
  submissions: SubmissionSummary[];
};

const STORAGE_KEY = "h5-multipart-session-v1";
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
    if (!parsed?.sessionId || !parsed.fileName || !parsed.participantCode) {
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
    return "已通过";
  }
  if (status === "rejected") {
    return "已拒绝";
  }
  return "待审核";
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

    xhr.onerror = () => reject(new Error("分片上传失败，请检查网络后重试。"));

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader("ETag")?.trim();
        if (!etag) {
          reject(new Error("分片上传成功，但响应头里缺少 ETag。"));
          return;
        }

        onProgress(blob.size);
        resolve(etag);
        return;
      }

      reject(new Error(`分片上传失败：HTTP ${xhr.status} ${xhr.responseText.slice(0, 300)}`));
    };

    xhr.send(blob);
  });
}

export default function H5UploadClient() {
  const [participantCodeInput, setParticipantCodeInput] = useState("");
  const [viewer, setViewer] = useState<ParticipantLookupResponse | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [comment, setComment] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [storedSession, setStoredSession] = useState<StoredMultipartSession | null>(null);

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
      setViewerError("请先输入上传码。");
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
    } catch (error) {
      setViewer(null);
      setViewerError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLookingUp(false);
    }
  };

  useEffect(() => {
    const nextStored = readStoredSession();
    setStoredSession(nextStored);
    if (nextStored?.participantCode) {
      setParticipantCodeInput(nextStored.participantCode);
      void loadParticipantByCode(nextStored.participantCode);
    }
  }, []);

  const resolvedParticipantCode = viewer?.participant.participant_code ?? participantCodeInput.trim();

  const canResumeCurrentFile =
    Boolean(storedSession) &&
    Boolean(file) &&
    Boolean(resolvedParticipantCode) &&
    storedSession?.participantCode === resolvedParticipantCode &&
    storedSession?.fileName === file?.name &&
    storedSession?.sizeBytes === file?.size;

  const handleSubmit = async () => {
    setLogs([]);
    setProgress(0);

    if (!viewer?.participant) {
      appendLog("error", "请先输入上传码并验证身份。");
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

    try {
      let sessionState: UploadSessionResponse;
      let sessionSnapshot: StoredMultipartSession;

      if (canResumeCurrentFile && storedSession) {
        appendLog("info", "检测到上次未完成上传，正在恢复分片会话。");
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
          updatedAt: new Date().toISOString(),
        };
        syncStoredSession(sessionSnapshot);
      } else {
        appendLog("info", "1/4 正在创建上传会话...");
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
            user_comment: comment.trim() || undefined,
          }),
        });

        appendLog("info", {
          session_id: init.session_id,
          participant_code: init.participant_code,
          part_count: init.part_count,
          part_size: init.part_size,
          storage: init.storage,
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
          user_comment: comment.trim() || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: null,
        };
      }

      if (sessionState.status !== "uploading") {
        throw new Error(`当前上传会话状态为 ${sessionState.status}，无法继续上传。`);
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

      appendLog(
        "info",
        `2/4 准备上传 ${sessionState.part_count} 个分片，已完成 ${uploadedParts.size} 个，待上传 ${pendingPartNumbers.length} 个。`,
      );

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

            if (uploadedParts.size === sessionState.part_count || uploadedParts.size % 5 === 0) {
              appendLog("info", `已上传 ${uploadedParts.size}/${sessionState.part_count} 个分片。`);
            }
            return;
          } catch (error) {
            lastError = error;
            progressByPart.delete(partNumber);
            updateOverallProgress();

            if (attempt < MAX_RETRIES_PER_PART) {
              appendLog("error", `分片 ${partNumber} 上传失败，准备第 ${attempt + 1} 次重试。`);
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

      appendLog("info", "3/4 正在合并云端分片...");

      const parts = Array.from(uploadedParts.entries())
        .sort(([a], [b]) => a - b)
        .map(([part_number, etag]) => ({ part_number, etag }));

      const completeResult = await fetchJson("/upload/multipart/complete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: sessionState.session_id,
          parts,
          user_comment: comment.trim() || undefined,
        }),
      });

      setProgress(100);
      appendLog("success", "4/4 上传完成，视频已写入系统。");
      appendLog("success", completeResult);
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
      appendLog("info", "已放弃上一次未完成的上传会话。");
    } catch (error) {
      appendLog("error", error instanceof Error ? error.message : String(error));
    } finally {
      clearStoredSession();
    }
  };

  return (
    <main className="upload-shell">
      <section className="upload-panel">
        <header className="upload-header">
          <p className="eyebrow">WeChat H5 Upload</p>
          <h1>微信公众号视频上传</h1>
          <p>
            先在公众号里发送
            <code> 上传码 </code>
            或
            <code> openid </code>
            ，系统会回复你的 6 位上传码。然后在这个 H5 页面里填入上传码，即可上传视频到腾讯云 COS。
          </p>
        </header>

        <div className="status-panel" style={{ marginBottom: 16 }}>
          <div className="status-row">
            <div className="status-chip">单页上传</div>
            <div className="status-chip">6 位上传码</div>
            <div className="status-chip">腾讯云 COS 分片上传</div>
          </div>
          <p className="field-hint">
            上传过程中建议保持页面在前台，不要锁屏，不要切换网络。
          </p>
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
                placeholder="请输入 6 位上传码"
              />
            </div>
          </div>
          <div className="submit-row">
            <button
              className="submit-button"
              disabled={isLookingUp || participantCodeInput.trim().length === 0}
              onClick={() => void loadParticipantByCode(participantCodeInput)}
              type="button"
            >
              {isLookingUp ? "验证中..." : "验证上传码"}
            </button>
          </div>
          {viewerError ? <p className="field-hint" style={{ marginTop: 14 }}>{viewerError}</p> : null}
        </div>

        {viewer?.participant ? (
          <div className="status-panel" style={{ marginBottom: 16 }}>
            <div className="status-row">
              <div className="status-chip">上传码 {viewer.participant.participant_code}</div>
              <div className="status-chip">状态 {viewer.participant.status}</div>
            </div>
            <p className="field-hint">
              当前用户：{viewer.participant.display_name} / {viewer.participant.display_phone}
            </p>
          </div>
        ) : null}

        {storedSession ? (
          <div className="status-panel" style={{ marginBottom: 16 }}>
            <div className="status-chip">发现未完成上传</div>
            <pre className="status-log">
              文件：{storedSession.fileName}
              {"\n"}
              大小：{formatBytes(storedSession.sizeBytes)}
              {"\n"}
              上传码：{storedSession.participantCode}
              {"\n"}
              最近更新时间：{storedSession.updatedAt}
            </pre>
            <div className="submit-row">
              <button className="submit-button" onClick={handleAbortStoredSession} type="button">
                放弃上次上传
              </button>
            </div>
          </div>
        ) : null}

        <div className="form-grid">
          <div className="field field-full">
            <label htmlFor="file">视频文件</label>
            <input
              id="file"
              type="file"
              accept="video/*"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            {file ? <small>已选择：{file.name}（{formatBytes(file.size)}）</small> : null}
          </div>

          <div className="field field-full">
            <label htmlFor="comment">备注</label>
            <textarea
              id="comment"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="可选，用于写入 user_comment。"
            />
          </div>
        </div>

        <div className="progress-stack">
          <div className="status-row">
            <div className="progress-chip">上传进度 {progress}%</div>
            <div className="status-chip">{canResumeCurrentFile ? "可断点续传" : "新上传任务"}</div>
          </div>
          <div aria-hidden="true" className="progress-track">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="submit-row">
          <button className="submit-button" disabled={isUploading || !viewer?.participant} onClick={handleSubmit} type="button">
            {isUploading ? "上传中..." : canResumeCurrentFile ? "继续上传" : "开始上传"}
          </button>
        </div>
      </section>

      {viewer?.submissions?.length ? (
        <section className="status-panel">
          <div className="status-chip">我的上传记录</div>
          <div className="submission-list">
            {viewer.submissions.map((submission) => (
              <article className="submission-card" key={submission.id}>
                <div className="status-row">
                  <strong>{submission.file_name || `视频 #${submission.id}`}</strong>
                  <span className="status-chip">{getReviewLabel(submission.review_status)}</span>
                </div>
                <p className="field-hint">提交时间：{formatDate(submission.created_at)}</p>
                {submission.reject_reason ? <p className="field-hint">驳回原因：{submission.reject_reason}</p> : null}
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
        <div className="status-chip">上传日志</div>
        <pre className="status-log">
          {logs.length === 0
            ? "会话创建、分片进度、完成回写和异常信息会显示在这里。"
            : logs.map((line, index) => (
                <span
                  className={line.type === "error" ? "error-line" : line.type === "success" ? "success-line" : ""}
                  key={`${line.type}-${index}`}
                >
                  {line.text}
                  {"\n"}
                </span>
              ))}
        </pre>
      </section>
    </main>
  );
}
