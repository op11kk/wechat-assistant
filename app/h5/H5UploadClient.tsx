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
    xhr.onerror = () =>
      reject(
        new Error(
          "浏览器直传失败（多为跨域）：请在对象存储控制台为当前站点配置 CORS，允许 PUT 与 Content-Type。",
        ),
      );
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
        return;
      }
        reject(new Error(`直传 PUT 失败: HTTP ${xhr.status} ${xhr.responseText.slice(0, 300)}`));
    };
    xhr.send(file);
  });
}

/** 同源 POST 到 /upload/proxy，由服务端写入 COS + Supabase，绕过浏览器对 COS 的 CORS。 */
function uploadViaServerProxy(
  file: File,
  params: { participantCode: string; wechatOpenid: string; apiSecret: string; comment: string },
  onProgress: (value: number) => void,
): Promise<unknown> {
  const contentType = file.type || "video/mp4";
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "X-Participant-Code": params.participantCode.trim(),
    "X-Wechat-Openid": params.wechatOpenid.trim(),
    "X-File-Name": encodeURIComponent(file.name),
  };
  if (params.apiSecret.trim()) {
    headers.Authorization = `Bearer ${params.apiSecret.trim()}`;
  }
  if (params.comment.trim()) {
    headers["X-User-Comment"] = encodeURIComponent(params.comment.trim());
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload/proxy", true);
    Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        return;
      }
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        try {
          resolve(JSON.parse(xhr.responseText) as unknown);
        } catch {
          resolve(xhr.responseText);
        }
        return;
      }
      reject(new Error(`中转上传失败: HTTP ${xhr.status} ${xhr.responseText.slice(0, 500)}`));
    };
    xhr.onerror = () => reject(new Error("中转上传网络错误（请检查网络或 Vercel 限制）"));
    xhr.send(file);
  });
}

/** 与服务端 `SINGLE_PROXY_MAX_BYTES` / `MULTIPART_PART_SIZE_BYTES` 一致（3MiB） */
const SERVER_SINGLE_BODY_MAX_BYTES = 3 * 1024 * 1024;

type MultipartInitResponse = {
  upload_id: string;
  object_key: string;
  session_token: string;
  part_size_bytes: number;
  total_parts: number;
};

/** 大于 3MB 的文件分片 POST，避免 Vercel FUNCTION_PAYLOAD_TOO_LARGE */
async function uploadViaServerProxyMultipart(
  file: File,
  params: { participantCode: string; wechatOpenid: string; apiSecret: string; comment: string },
  onProgress: (value: number) => void,
): Promise<unknown> {
  const contentType = file.type || "video/mp4";
  const authHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (params.apiSecret.trim()) {
    authHeaders.Authorization = `Bearer ${params.apiSecret.trim()}`;
  }

  const initRes = await fetch("/upload/multipart/init", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      participant_code: params.participantCode.trim(),
      wechat_openid: params.wechatOpenid.trim(),
      file_name: file.name,
      content_type: contentType,
      total_size: file.size,
    }),
  });
  if (!initRes.ok) {
    throw new Error(`分片初始化失败: HTTP ${initRes.status} ${JSON.stringify(await readJsonOrText(initRes))}`);
  }
  const init = (await initRes.json()) as MultipartInitResponse;
  const partSize = init.part_size_bytes;
  const parts: { PartNumber: number; ETag: string }[] = [];

  let partNum = 1;
  for (let offset = 0; offset < file.size; offset += partSize, partNum += 1) {
    const chunk = file.slice(offset, Math.min(offset + partSize, file.size));
    const buf = await chunk.arrayBuffer();
    const partHeaders: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "X-Part-Number": String(partNum),
      "X-Multipart-Session": init.session_token,
      "X-Participant-Code": params.participantCode.trim(),
      "X-Wechat-Openid": params.wechatOpenid.trim(),
    };
    if (params.apiSecret.trim()) {
      partHeaders.Authorization = `Bearer ${params.apiSecret.trim()}`;
    }
    const pr = await fetch("/upload/multipart/part", {
      method: "POST",
      headers: partHeaders,
      body: buf,
    });
    if (!pr.ok) {
      throw new Error(`分片 ${partNum}/${init.total_parts} 失败: HTTP ${pr.status} ${JSON.stringify(await readJsonOrText(pr))}`);
    }
    const row = (await pr.json()) as { etag: string };
    parts.push({ PartNumber: partNum, ETag: row.etag });
    onProgress(Math.round((partNum / init.total_parts) * 100));
  }

  const completeRes = await fetch("/upload/multipart/complete", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      session_token: init.session_token,
      parts,
      user_comment: params.comment.trim() || undefined,
    }),
  });
  if (!completeRes.ok) {
    throw new Error(`合并分片失败: HTTP ${completeRes.status} ${JSON.stringify(await readJsonOrText(completeRes))}`);
  }
  return await readJsonOrText(completeRes);
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
  /** 不经浏览器直传 COS，避免 COS CORS；大文件受 Vercel 请求体限制。 */
  const [useServerProxy, setUseServerProxy] = useState(true);

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

      if (useServerProxy) {
        const p = {
          participantCode: participantCode.trim(),
          wechatOpenid: wechatOpenid.trim(),
          apiSecret: apiSecret.trim(),
          comment: comment.trim(),
        };
        try {
          if (file.size <= SERVER_SINGLE_BODY_MAX_BYTES) {
            appendLog(
              "info",
              `经服务器单次中转（≤${(SERVER_SINGLE_BODY_MAX_BYTES / 1024 / 1024).toFixed(0)}MB，同源免 COS CORS）。`,
            );
            const result = await uploadViaServerProxy(file, p, setProgress);
            appendLog("success", result);
          } else {
            appendLog(
              "info",
              `文件约 ${(file.size / 1024 / 1024).toFixed(2)}MB，使用分片中转（每片 ${(SERVER_SINGLE_BODY_MAX_BYTES / 1024 / 1024).toFixed(0)}MB，需配置 API_SECRET 或 WECHAT_TOKEN 做会话签名校验）。`,
            );
            const result = await uploadViaServerProxyMultipart(file, p, setProgress);
            appendLog("success", result);
          }
        } catch (error) {
          appendLog("error", String(error));
        }
        return;
      }

      appendLog("info", "1/3 请求对象存储预签名。");
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

      appendLog("info", "2/3 正在直传到对象存储。");
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
          <p className="eyebrow">H5 直传</p>
          <h1>大视频上传页</h1>
          <p>
            默认<strong>经本站中转</strong>：≤3MB 单次请求；更大文件自动<strong>分片</strong>上传（需已配置{" "}
            <code>API_SECRET</code> 或 <code>WECHAT_TOKEN</code> 做分片会话签名）。取消勾选可改为<strong>预签名直传</strong>
            （需在 COS 配 CORS）。参与者须为 <code>active</code>。
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
            <label className="field-checkbox">
              <input
                checked={useServerProxy}
                onChange={(event) => setUseServerProxy(event.target.checked)}
                type="checkbox"
              />{" "}
              经服务器中转上传（免 COS 跨域；大文件请配好 CORS 后取消勾选用直传）
            </label>
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
