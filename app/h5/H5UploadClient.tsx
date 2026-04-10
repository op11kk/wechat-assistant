"use client";

import { useState, useTransition } from "react";

type LogLine = {
  type: "info" | "error" | "success";
  text: string;
};

type PresignResponse = {
  url?: string;
  upload_url?: string;
  object_key: string;
  headers?: Record<string, string>;
};

function formatLogValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

async function readJsonOrText(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text || response.statusText;
  }
}

function uploadWithProgress(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress: (value: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        return;
      }
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new Error("Upload request failed"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
        return;
      }
      reject(new Error(`R2 PUT failed: HTTP ${xhr.status} ${xhr.responseText.slice(0, 300)}`));
    };
    xhr.send(file);
  });
}

export default function H5UploadClient() {
  const [participantCode, setParticipantCode] = useState("");
  const [wechatOpenid, setWechatOpenid] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [comment, setComment] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [isPending, startTransition] = useTransition();

  const appendLog = (type: LogLine["type"], value: unknown) => {
    setLogs((current) => [...current, { type, text: formatLogValue(value) }]);
  };

  const apiHeaders = () => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiSecret.trim()) {
      headers.Authorization = `Bearer ${apiSecret.trim()}`;
    }
    return headers;
  };

  const handleSubmit = () => {
    startTransition(async () => {
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

      const contentType = file.type || "video/mp4";

      appendLog("info", "1/3 请求 Cloudflare R2 预签名。");
      const presignResponse = await fetch("/upload/presign", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({
          participant_code: participantCode.trim(),
          wechat_openid: wechatOpenid.trim(),
          content_type: contentType,
          file_name: file.name,
          mime: contentType,
        }),
      });

      if (!presignResponse.ok) {
        appendLog("error", await readJsonOrText(presignResponse));
        return;
      }

      const presign = (await presignResponse.json()) as PresignResponse;
      appendLog("info", presign);
      const uploadUrl = presign.upload_url ?? presign.url;
      if (!uploadUrl) {
        appendLog("error", "预签名响应缺少 url 字段。");
        return;
      }

      appendLog("info", "2/3 正在直传到 Cloudflare R2。");
      try {
        await uploadWithProgress(
          uploadUrl,
          file,
          {
            "Content-Type": contentType,
            ...(presign.headers ?? {}),
          },
          setProgress,
        );
      } catch (error) {
        appendLog("error", String(error));
        return;
      }

      appendLog("success", `上传完成，进度 ${progress || 100}%。`);
      appendLog("info", "3/3 回写 video_submissions。");

      const completeResponse = await fetch("/upload/complete", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({
          participant_code: participantCode.trim(),
          wechat_openid: wechatOpenid.trim(),
          source: "h5",
          object_key: presign.object_key,
          file_name: file.name,
          size_bytes: file.size,
          mime: contentType,
          user_comment: comment.trim() || undefined,
        }),
      });

      if (!completeResponse.ok) {
        appendLog("error", await readJsonOrText(completeResponse));
        return;
      }

      appendLog("success", await readJsonOrText(completeResponse));
    });
  };

  return (
    <main className="upload-shell">
      <section className="upload-panel">
        <header className="upload-header">
          <p className="eyebrow">Cloudflare R2 Upload</p>
          <h1>大视频上传页</h1>
          <p>
            现在的流程是 Next.js 路由签发 R2 预签名，浏览器直接 PUT 到 Cloudflare R2，成功后再写入
            Supabase 的 <code>video_submissions</code>。
          </p>
        </header>

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
              placeholder="微信 openid"
            />
          </div>

          <div className="field field-full">
            <label htmlFor="apiSecret">API_SECRET</label>
            <input
              id="apiSecret"
              value={apiSecret}
              onChange={(event) => setApiSecret(event.target.value)}
              placeholder="如果服务端配置了 API_SECRET，这里填同一个值"
            />
            <p className="field-hint">未配置 API_SECRET 时可以留空。</p>
          </div>

          <div className="field field-full">
            <label htmlFor="file">视频文件</label>
            <input
              id="file"
              type="file"
              accept="video/*"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
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
          <button className="submit-button" disabled={isPending} onClick={handleSubmit} type="button">
            {isPending ? "处理中..." : "开始上传"}
          </button>
          <div className="progress-chip">上传进度 {progress}%</div>
        </div>
      </section>

      <section className="status-panel">
        <div className="status-chip">执行日志</div>
        <pre className="status-log">
          {logs.length === 0
            ? "还没有日志。提交后会显示预签名、直传和回写结果。"
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
