"use client";

import { useEffect, useState } from "react";

import { DEFAULT_MULTIPART_CONCURRENCY } from "@/lib/upload-multipart";

type LogLine = {
  type: "info" | "error" | "success";
  text: string;
};

type MultipartInitResponse = {
  session_id: string;
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
  wechatOpenid: string;
  fileName: string;
  sizeBytes: number;
  mime: string;
  objectKey: string;
  partSize: number;
  partCount: number;
  updatedAt: string;
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
    if (!parsed?.sessionId || !parsed.fileName) {
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
    xhr.onerror = () =>
      reject(new Error("浏览器直传分片失败：请检查网络，且上传过程中不要切后台或锁屏。"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader("ETag")?.trim();
        if (!etag) {
          reject(new Error("分片上传成功，但响应头缺少 ETag。"));
          return;
        }
        onProgress(blob.size);
        resolve(etag);
        return;
      }
      reject(new Error(`分片上传失败: HTTP ${xhr.status} ${xhr.responseText.slice(0, 300)}`));
    };
    xhr.send(blob);
  });
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const detail = await readJsonOrText(response);
    throw new Error(formatLogValue(detail));
  }
  return (await response.json()) as T;
}

export default function H5UploadClient() {
  const [participantCode, setParticipantCode] = useState("");
  const [wechatOpenid, setWechatOpenid] = useState("");
  const [comment, setComment] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [storedSession, setStoredSession] = useState<StoredMultipartSession | null>(null);

  const appendLog = (type: LogLine["type"], value: unknown) => {
    setLogs((current) => [...current, { type, text: formatLogValue(value) }]);
  };

  useEffect(() => {
    setStoredSession(readStoredSession());
  }, []);

  const syncStoredSession = (session: StoredMultipartSession | null) => {
    setStoredSession(session);
    writeStoredSession(session);
  };

  const clearStoredSession = () => {
    syncStoredSession(null);
  };

  const canResumeCurrentFile =
    storedSession &&
    file &&
    storedSession.participantCode === participantCode.trim() &&
    storedSession.wechatOpenid === wechatOpenid.trim() &&
    storedSession.fileName === file.name &&
    storedSession.sizeBytes === file.size;

  const handleSubmit = async () => {
    setLogs([]);
    setProgress(0);

    if (!participantCode.trim() || !wechatOpenid.trim()) {
      appendLog("error", "请填写 participant_code 和 wechat_openid。");
      return;
    }
    if (!file) {
      appendLog("error", "请先选择视频文件。");
      return;
    }

    setIsUploading(true);
    const contentType = file.type || "video/mp4";
    const participantCodeTrimmed = participantCode.trim();
    const wechatOpenidTrimmed = wechatOpenid.trim();
    const progressByPart = new Map<number, number>();

    try {
      let sessionState: UploadSessionResponse;
      let sessionSnapshot: StoredMultipartSession;

      if (canResumeCurrentFile) {
        appendLog("info", "检测到同一文件的未完成会话，正在恢复上传状态。");
        sessionState = await fetchJson<UploadSessionResponse>(`/upload/multipart/session/${storedSession.sessionId}`);
        sessionSnapshot = {
          sessionId: sessionState.session_id,
          participantCode: participantCodeTrimmed,
          wechatOpenid: wechatOpenidTrimmed,
          fileName: file.name,
          sizeBytes: file.size,
          mime: contentType,
          objectKey: sessionState.object_key,
          partSize: sessionState.part_size,
          partCount: sessionState.part_count,
          updatedAt: new Date().toISOString(),
        };
        syncStoredSession(sessionSnapshot);
      } else {
        appendLog("info", "1/4 创建分片上传会话。");
        const init = await fetchJson<MultipartInitResponse>("/upload/multipart/init", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            participant_code: participantCodeTrimmed,
            wechat_openid: wechatOpenidTrimmed,
            content_type: contentType,
            file_name: file.name,
            size_bytes: file.size,
            user_comment: comment.trim() || undefined,
          }),
        });
        appendLog("info", init);
        sessionSnapshot = {
          sessionId: init.session_id,
          participantCode: participantCodeTrimmed,
          wechatOpenid: wechatOpenidTrimmed,
          fileName: file.name,
          sizeBytes: file.size,
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
          file_name: file.name,
          size_bytes: file.size,
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
        throw new Error(`当前会话状态为 ${sessionState.status}，不能继续上传。`);
      }

      const uploadedParts = new Map<number, string>(
        sessionState.uploaded_parts.map((part) => [part.part_number, part.etag]),
      );

      const updateOverallProgress = () => {
        let uploadedBytes = 0;
        for (const partNumber of uploadedParts.keys()) {
          uploadedBytes += getPartBytes(file.size, sessionState.part_size, partNumber);
        }
        for (const [partNumber, loadedBytes] of progressByPart.entries()) {
          if (uploadedParts.has(partNumber)) {
            continue;
          }
          uploadedBytes += loadedBytes;
        }
        const nextProgress = Math.min(100, Math.round((uploadedBytes / file.size) * 100));
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
        const blob = slicePart(file, sessionState.part_size, partNumber);
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
            const etag = await uploadPartWithProgress(
              presign.url,
              blob,
              presign.headers ?? {},
              (loadedBytes) => {
                progressByPart.set(partNumber, loadedBytes);
                updateOverallProgress();
              },
            );
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
              appendLog("info", `已完成 ${uploadedParts.size}/${sessionState.part_count} 个分片。`);
            }
            return;
          } catch (error) {
            lastError = error;
            progressByPart.delete(partNumber);
            updateOverallProgress();
            if (attempt < MAX_RETRIES_PER_PART) {
              appendLog("error", `分片 ${partNumber} 上传失败，正在重试（${attempt}/${MAX_RETRIES_PER_PART}）`);
              continue;
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

      appendLog("info", "3/4 所有分片已上传，正在合并对象。");

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
      appendLog("success", "4/4 上传完成，已写入 video_submissions。");
      appendLog("success", completeResult);
      clearStoredSession();
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
      appendLog("info", "已放弃未完成的分片上传会话。");
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
          <p className="eyebrow">H5 上传</p>
          <h1>大视频分片上传页</h1>
          <p>
            当前页面默认使用
            <strong>腾讯云 COS 分片直传</strong>
            。上传过程中请保持页面在前台，不要锁屏或切换到其他页面。
          </p>
        </header>

        {storedSession ? (
          <div className="status-panel" style={{ marginBottom: 16 }}>
            <div className="status-chip">检测到未完成会话</div>
            <pre className="status-log">
              文件：{storedSession.fileName}
              {"\n"}
              大小：{formatBytes(storedSession.sizeBytes)}
              {"\n"}
              participant_code：{storedSession.participantCode}
              {"\n"}
              会话更新时间：{storedSession.updatedAt}
            </pre>
            <div className="submit-row">
              <button className="submit-button" onClick={handleAbortStoredSession} type="button">
                放弃上次上传会话
              </button>
            </div>
          </div>
        ) : null}

        <div className="form-grid">
          <div className="field">
            <label htmlFor="participantCode">participant_code</label>
            <input
              id="participantCode"
              value={participantCode}
              onChange={(event) => setParticipantCode(event.target.value)}
              placeholder="例如 000123"
            />
          </div>

          <div className="field">
            <label htmlFor="wechatOpenid">wechat_openid</label>
            <input
              id="wechatOpenid"
              value={wechatOpenid}
              onChange={(event) => setWechatOpenid(event.target.value)}
              placeholder="管理员提供的微信 openid"
            />
          </div>

          <div className="field field-full">
            <label htmlFor="file">视频文件</label>
            <input
              id="file"
              type="file"
              accept="video/*"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            {file ? (
              <small>
                已选择：{file.name}（{formatBytes(file.size)}）
              </small>
            ) : null}
          </div>

          <div className="field field-full">
            <label htmlFor="comment">备注</label>
            <textarea
              id="comment"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="会写入 user_comment，可选。"
            />
          </div>
        </div>

        <div className="submit-row">
          <button className="submit-button" disabled={isUploading} onClick={handleSubmit} type="button">
            {isUploading ? "上传中..." : canResumeCurrentFile ? "继续上传" : "开始上传"}
          </button>
          <div className="progress-chip">上传进度 {progress}%</div>
        </div>
      </section>

      <section className="status-panel">
        <div className="status-chip">执行日志</div>
        <pre className="status-log">
          {logs.length === 0
            ? "还没有日志。提交后会显示会话创建、分片上传和完成回写结果。"
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
