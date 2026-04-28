"use client";

import { useEffect, useRef, useState } from "react";
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

type LeaderReferralSummary = {
  promoter_id: number | null;
  promoter_name: string;
  promo_code: string;
  status: "active" | "disabled";
};

type ParticipantLookupResponse = {
  participant: {
    id: number;
    participant_code: string;
    status: string;
    display_name: string;
    display_phone: string;
  };
  leader_referral: LeaderReferralSummary | null;
  workflow: WorkflowSummary;
  scenes: Array<{
    name: string;
    remaining_text: string;
    description: string;
  }>;
  submissions: SubmissionSummary[];
};

type LeaderReferralBindResponse = {
  status: "bound" | "already_bound";
  participant_code: string;
  leader_referral: LeaderReferralSummary | null;
  detail: string | null;
};

type AccessConfirmState = "idle" | "success" | "invalid" | "network";

const STORAGE_KEY = "h5-multipart-session-v2";
const MAX_RETRIES_PER_PART = 3;
const DEFAULT_REMOTE_API_ORIGIN = "https://api.capego.top";
const CONFIGURED_API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
const LOOKUP_TIMEOUT_MS = 12_000;
const MUTATION_TIMEOUT_MS = 20_000;
const LOOKUP_RETRY_ATTEMPTS = 3;
const MUTATION_RETRY_ATTEMPTS = 3;
const MIN_PART_UPLOAD_TIMEOUT_MS = 120_000;
const MOBILE_PART_UPLOAD_TIMEOUT_MS = 360_000;
const VERY_SLOW_PART_UPLOAD_TIMEOUT_MS = 600_000;

type NetworkInformationLike = {
  downlink?: number;
  effectiveType?: string;
  saveData?: boolean;
  type?: string;
};

class FetchJsonError extends Error {
  readonly retriable: boolean;
  readonly status: number;

  constructor(message: string, status: number, retriable: boolean) {
    super(message);
    this.name = "FetchJsonError";
    this.status = status;
    this.retriable = retriable;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getNetworkInformation(): NetworkInformationLike | null {
  if (typeof window === "undefined" || typeof window.navigator === "undefined") {
    return null;
  }

  const navigatorWithConnection = window.navigator as Navigator & {
    connection?: NetworkInformationLike;
    mozConnection?: NetworkInformationLike;
    webkitConnection?: NetworkInformationLike;
  };

  return (
    navigatorWithConnection.connection ??
    navigatorWithConnection.mozConnection ??
    navigatorWithConnection.webkitConnection ??
    null
  );
}

function isMobileUploadEnvironment(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const connection = getNetworkInformation();
  const effectiveType = connection?.effectiveType?.toLowerCase() ?? "";
  if (connection?.saveData || effectiveType === "slow-2g" || effectiveType === "2g" || effectiveType === "3g") {
    return true;
  }

  return /android|iphone|ipad|ipod|mobile|micromessenger/i.test(window.navigator.userAgent);
}

function getUploadConcurrency(pendingPartCount: number): number {
  const maxConcurrency = isMobileUploadEnvironment() ? 1 : DEFAULT_MULTIPART_CONCURRENCY;
  return Math.min(maxConcurrency, Math.max(pendingPartCount, 1));
}

function getPartUploadTimeoutMs(blobSize: number): number {
  const connection = getNetworkInformation();
  const effectiveType = connection?.effectiveType?.toLowerCase() ?? "";

  if (effectiveType === "slow-2g" || effectiveType === "2g") {
    return VERY_SLOW_PART_UPLOAD_TIMEOUT_MS;
  }

  if (isMobileUploadEnvironment()) {
    return MOBILE_PART_UPLOAD_TIMEOUT_MS;
  }

  const downlinkMbps = connection?.downlink;
  if (downlinkMbps && Number.isFinite(downlinkMbps) && downlinkMbps > 0) {
    const bytesPerMs = (downlinkMbps * 125_000) / 1000;
    return Math.max(MIN_PART_UPLOAD_TIMEOUT_MS, Math.ceil((blobSize / bytesPerMs) * 4));
  }

  return MIN_PART_UPLOAD_TIMEOUT_MS;
}

function getRetryDelayMs(attempt: number): number {
  const baseDelay = isMobileUploadEnvironment() ? 900 : 450;
  const jitter = Math.floor(Math.random() * 250);
  return baseDelay * attempt * attempt + jitter;
}

function waitForOnline(timeoutMs = 15_000): Promise<void> {
  if (typeof window === "undefined" || window.navigator.onLine) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("online", done);
      resolve();
    };
    const timeoutId = window.setTimeout(done, timeoutMs);
    window.addEventListener("online", done, { once: true });
  });
}

async function waitBeforeRetry(attempt: number): Promise<void> {
  await waitForOnline();
  await sleep(getRetryDelayMs(attempt));
}

function resolveApiBaseUrl(): string {
  if (CONFIGURED_API_BASE_URL) {
    return CONFIGURED_API_BASE_URL;
  }

  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return "";
    }
  }

  return DEFAULT_REMOTE_API_ORIGIN;
}

function buildApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const baseUrl = resolveApiBaseUrl();
  return baseUrl ? `${baseUrl}${normalizedPath}` : normalizedPath;
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function normalizeSixDigitCode(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

function isNetworkErrorLike(error: unknown): boolean {
  if (error instanceof FetchJsonError) {
    return false;
  }
  if (error instanceof TypeError) {
    return true;
  }
  if (error instanceof Error) {
    return /failed to fetch|network|timeout|timed out|load failed|abort/i.test(error.message);
  }
  return false;
}

function isNetworkLikeMessage(message: string): boolean {
  return /网络|timeout|timed out|failed to fetch|network|中断|断开/i.test(message);
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
  const inputUrl = typeof input === "string" ? buildApiUrl(input) : input;
  const attempts = init?.method && init.method !== "GET" && init.method !== "HEAD" ? MUTATION_RETRY_ATTEMPTS : LOOKUP_RETRY_ATTEMPTS;
  const timeoutMs = init?.method && init.method !== "GET" && init.method !== "HEAD" ? MUTATION_TIMEOUT_MS : LOOKUP_TIMEOUT_MS;

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(inputUrl, {
        ...init,
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await readJsonOrText(response);
        const message = formatLogValue(detail);
        const shouldRetry = response.status >= 500 || response.status === 429;
        if (attempt < attempts && shouldRetry) {
          await waitBeforeRetry(attempt);
          continue;
        }
        throw new FetchJsonError(message, response.status, shouldRetry);
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      const isAbort = error instanceof DOMException && error.name === "AbortError";
      const isRetriable = !(error instanceof FetchJsonError) || error.retriable;
      if (attempt < attempts && isRetriable) {
        await waitBeforeRetry(attempt);
        continue;
      }
      if (isAbort) {
        throw new Error("请求超时，请检查网络后重试。");
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
    xhr.timeout = getPartUploadTimeoutMs(blob.size);

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

    xhr.ontimeout = () => {
      reject(new Error("上传超时，正在重试。"));
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


export default function H5UploadClient() {
  const searchParams = useSearchParams();
  const openedFromMenu = searchParams.get("from")?.trim() === "menu";
  const [participantCodeInput, setParticipantCodeInput] = useState("");
  const [leaderPromoCodeInput, setLeaderPromoCodeInput] = useState("");
  const [viewer, setViewer] = useState<ParticipantLookupResponse | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [scene, setScene] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isFinalizingUpload, setIsFinalizingUpload] = useState(false);
  const [isUploadConfirmed, setIsUploadConfirmed] = useState(false);
  const [storedSession, setStoredSession] = useState<StoredMultipartSession | null>(null);
  const [accessConfirmState, setAccessConfirmState] = useState<AccessConfirmState>("idle");
  const uploadInFlightRef = useRef(false);

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
      setViewerError("请先输入 6 位身份码。");
      setAccessConfirmState("invalid");
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

  const confirmParticipantAccess = async (
    code: string,
    options?: {
      leaderPromoCode?: string;
    },
  ) => {
    const normalizedCode = normalizeSixDigitCode(code);
    const normalizedLeaderPromoCode = normalizeSixDigitCode(options?.leaderPromoCode ?? leaderPromoCodeInput);

    if (!normalizedCode) {
      setViewer(null);
      setViewerError("请先输入 6 位身份码。");
      return;
    }

    setIsLookingUp(true);
    setViewerError(null);

    let fallbackViewer: ParticipantLookupResponse | null = null;

    try {
      const nextViewer = await fetchJson<ParticipantLookupResponse>(
        `/api/h5/code/${encodeURIComponent(normalizedCode)}`,
      );
      fallbackViewer = nextViewer;

      let resolvedViewer = nextViewer;
      const currentBoundLeaderCode = nextViewer.leader_referral?.promo_code ?? "";

      if (normalizedLeaderPromoCode) {
        if (currentBoundLeaderCode && currentBoundLeaderCode !== normalizedLeaderPromoCode) {
          setViewer(nextViewer);
          setLeaderPromoCodeInput(currentBoundLeaderCode);
          throw new Error("当前账号已绑定其他团长推广码，暂不支持修改。");
        }

        if (!currentBoundLeaderCode) {
          await fetchJson<LeaderReferralBindResponse>("/api/h5/leader-referral/bind", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              participant_code: nextViewer.participant.participant_code,
              leader_promo_code: normalizedLeaderPromoCode,
            }),
          });

          resolvedViewer = await fetchJson<ParticipantLookupResponse>(
            `/api/h5/code/${encodeURIComponent(normalizedCode)}`,
          );
        }
      }

      setViewer(resolvedViewer);
      setParticipantCodeInput(resolvedViewer.participant.participant_code);
      setLeaderPromoCodeInput(resolvedViewer.leader_referral?.promo_code ?? normalizedLeaderPromoCode);
      setAccessConfirmState("success");
      const nextScene = resolvedViewer.scenes[0]?.name ?? "";
      setScene((current) =>
        current && resolvedViewer.scenes.some((item) => item.name === current) ? current : nextScene,
      );
    } catch (error) {
      setViewer(fallbackViewer);
      if (isNetworkErrorLike(error)) {
        setViewerError("网络错误，请重试");
        setAccessConfirmState("network");
      } else {
        setViewerError(error instanceof Error ? error.message : String(error));
        setAccessConfirmState("invalid");
      }
    } finally {
      setIsLookingUp(false);
    }
  };

  useEffect(() => {
    const codeFromQuery = searchParams.get("code")?.trim() ?? "";
    const leaderPromoCodeFromQuery = normalizeSixDigitCode(
      searchParams.get("leader")?.trim() ??
        searchParams.get("promo")?.trim() ??
        searchParams.get("leaderPromoCode")?.trim() ??
        "",
    );
    const nextStored = readStoredSession();
    setStoredSession(nextStored);

    const initialCode = codeFromQuery || nextStored?.participantCode || "";
    setLeaderPromoCodeInput(leaderPromoCodeFromQuery);
    if (!initialCode) {
      return;
    }

    setParticipantCodeInput(initialCode);
    void loadParticipantByCode(initialCode);
  }, [searchParams]);

  useEffect(() => {
    if (typeof window === "undefined" || (!isUploading && !isFinalizingUpload)) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [isFinalizingUpload, isUploading]);

  const resolvedParticipantCode = viewer?.participant.participant_code ?? participantCodeInput.trim();
  const activeUploadKind = viewer?.workflow.current_upload_kind ?? "test";
  const canUpload = Boolean(viewer?.workflow.can_upload && viewer?.participant);
  const isAccessConfirmed = accessConfirmState === "success" && Boolean(viewer?.participant);
  const confirmInlineMessage =
    accessConfirmState === "success"
      ? "确认成功"
      : accessConfirmState === "invalid"
        ? "上传码错误，请重试"
        : accessConfirmState === "network"
          ? "网络错误，请重试"
          : null;

  const canResumeCurrentFile =
    Boolean(storedSession) &&
    Boolean(file) &&
    Boolean(resolvedParticipantCode) &&
    storedSession?.participantCode === resolvedParticipantCode &&
    storedSession?.fileName === file?.name &&
    storedSession?.sizeBytes === file?.size &&
    storedSession?.scene === scene &&
    storedSession?.uploadKind === activeUploadKind;
  const selectedSceneMeta = viewer?.scenes.find((item) => item.name === scene) ?? null;
  const uploadFailureReason =
    latestLog?.type === "error"
      ? isNetworkLikeMessage(latestLog.text)
        ? "网络断开失败"
        : "上传失败"
      : null;

  const handleSubmit = async () => {
    setLogs([]);
    setProgress(0);
    setIsUploadConfirmed(false);
    setIsFinalizingUpload(false);

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

    if (uploadInFlightRef.current) {
      return;
    }
    uploadInFlightRef.current = true;
    setIsUploading(true);
    const selectedFile = file;
    const contentType = selectedFile.type || "video/mp4";
    const progressByPart = new Map<number, number>();
    const structuredComment = encodeSubmissionMeta({
      kind: activeUploadKind,
      scene,
      note: null,
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

        const nextProgress = Math.min(99, Math.round((uploadedBytes / selectedFile.size) * 100));
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

      const concurrency = getUploadConcurrency(pendingPartNumbers.length);
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
              await waitBeforeRetry(attempt);
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
      setIsUploading(false);
      setIsFinalizingUpload(true);

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
      setIsFinalizingUpload(false);
      setIsUploadConfirmed(true);
      appendLog(
        "success",
        activeUploadKind === "test"
          ? "测试视频已上传成功，请等待审核结果。"
          : "正式视频已上传成功，系统会尽快审核。",
      );
      clearStoredSession();
      setFile(null);
      await loadParticipantByCode(viewer.participant.participant_code);
    } catch (error) {
      setIsFinalizingUpload(false);
      setIsUploadConfirmed(false);
      appendLog("error", error instanceof Error ? error.message : String(error));
    } finally {
      uploadInFlightRef.current = false;
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

        <div className="status-panel feature-panel" style={{ fontWeight: 600, marginTop: 24, marginBottom: 16 }}>
          <div className="feature-lines">
            <p>
              <strong>用途说明：</strong>
              本次提交内容将用于机器人训练与具身智能算法研发。
            </p>
            <p>
              <strong>上传前提示：</strong>
              请先选择场景，再上传对应视频；上传过程中不要关闭页面。
            </p>
            <p>
              <strong>审核规则：</strong>
              测试视频仅用于审核拍摄质量，不计收益；正式视频提交后进入审核流程。
            </p>
          </div>
        </div>

        <div className="status-panel" style={{ marginBottom: 16 }}>
          <div className="form-grid code-entry-grid" style={{ marginTop: 0 }}>
            <div className="field">
              <label htmlFor="participantCode">身份码</label>
              <input
                id="participantCode"
                inputMode="numeric"
                maxLength={6}
                value={participantCodeInput}
                onChange={(event) => {
                  setParticipantCodeInput(normalizeSixDigitCode(event.target.value));
                  setAccessConfirmState("idle");
                  setViewer(null);
                  setViewerError(null);
                }}
                placeholder="请输入公众号里收到的 6 位身份码"
              />
              <p className="field-hint">
                {openedFromMenu
                  ? "如果没有自动带入身份码，请回到公众号点击【我的身份码】复制 6 位身份码后再回来输入。"
                  : "如果你是从公众号链接进入，系统通常会自动带入身份码。"}
              </p>
            </div>
          </div>
          <div className="field referral-field" style={{ marginTop: 14 }}>
            <label htmlFor="leaderPromoCodeClean">推荐码(可选)</label>
            <input
              id="leaderPromoCodeClean"
              inputMode="numeric"
              maxLength={6}
              value={leaderPromoCodeInput}
              onChange={(event) => {
                setLeaderPromoCodeInput(normalizeSixDigitCode(event.target.value));
                if (!viewer?.leader_referral) {
                  setAccessConfirmState("idle");
                  setViewerError(null);
                }
              }}
              placeholder="如有推荐码，请输入 6 位数字"
              disabled={Boolean(viewer?.leader_referral)}
            />
            <p className="field-hint">
              如果是通过团长渠道开始任务则填写推荐码，若不是则不用填写。
            </p>
          </div>
          <div className="submit-row confirm-action-row">
            {!isAccessConfirmed ? (
              <button
                className="submit-button"
                disabled={isLookingUp || participantCodeInput.trim().length === 0}
                onClick={() =>
                  void confirmParticipantAccess(participantCodeInput, {
                    leaderPromoCode: leaderPromoCodeInput,
                  })
                }
                type="button"
              >
                <span style={{ alignItems: "center", display: "inline-flex", gap: 10 }}>
                  <span>请确认上传码</span>
                  {isLookingUp ? (
                    <span
                      aria-hidden="true"
                      style={{
                        animation: "h5LookupSpin 0.75s linear infinite",
                        border: "2px solid rgba(255, 255, 255, 0.38)",
                        borderRadius: "999px",
                        borderTopColor: "#ffffff",
                        display: "inline-block",
                        height: 18,
                        width: 18,
                      }}
                    />
                  ) : null}
                </span>
              </button>
            ) : null}
            {confirmInlineMessage ? (
              <span
                className={`confirm-feedback ${accessConfirmState === "success" ? "is-success" : "is-error"}`}
              >
                {confirmInlineMessage}
              </span>
            ) : null}
          </div>
        </div>

        {isAccessConfirmed && storedSession ? (
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

        {isAccessConfirmed && viewer?.workflow ? (
          <div className="status-panel workflow-panel" style={{ marginBottom: 16 }}>
            <div className="status-row" style={{ marginBottom: 18 }}>
              <div className="status-chip">身份码 {viewer.participant.participant_code}</div>
            </div>
            <div className="form-grid" style={{ marginTop: 20 }}>
              <div className="field">
                <label htmlFor="scene">拍摄场景</label>
                <p className="field-hint">请选择本次拍摄场景</p>
                <select id="scene" value={scene} onChange={(event) => setScene(event.target.value)}>
                  <option value="">请选择场景</option>
                  {viewer.scenes.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name} {item.remaining_text ? `（此时剩余采集员名额：${item.remaining_text}）` : ""}
                    </option>
                  ))}
                </select>
                <p className="field-hint quota-warning">当前数据采集员名额紧缺，请尽快提交审核，以提高通过率尽快获得收益</p>
                {selectedSceneMeta ? (
                  <div className="scene-selected">
                    <strong>{selectedSceneMeta.name}</strong>
                    <p>{selectedSceneMeta.description}</p>
                  </div>
                ) : null}
              </div>

              <div className="field">
                <label htmlFor="file">上传视频</label>
                <p className="field-hint tutorial-hint">请根据教程进行视频拍摄，以提高审核通过率</p>
                <input
                  id="file"
                  type="file"
                  accept="video/*"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
                {file ? <small>已选择：{file.name}（{formatBytes(file.size)}）</small> : null}
                <p className="field-hint">
                  <strong>视频上传需要时间，请耐心等待，上传完成前请勿关闭页面。</strong>
                </p>
              </div>
            </div>

            <div className="progress-stack">
              <div className="status-row">
                <div className="progress-chip">上传进度 {progress}%</div>
                {isFinalizingUpload ? <div className="status-chip">视频马上上传成功，请等待</div> : null}
                {isUploadConfirmed ? <div className="status-chip success-chip">上传成功</div> : null}
                {latestLog?.type === "error" ? <div className="status-chip error-chip">上传失败</div> : null}
                {uploadFailureReason ? <div className="status-chip error-chip">{uploadFailureReason}</div> : null}
                {canResumeCurrentFile ? <div className="status-chip">支持继续上传</div> : null}
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
                <p>
                  <strong>{submission.file_name || `视频 #${submission.id}`}</strong>
                </p>
                {submission.scene ? <p className="field-hint">待审核场景：{submission.scene}</p> : null}
                <p className="field-hint">提交时间：{formatDate(submission.created_at)}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      <style jsx>{`
        @keyframes h5LookupSpin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }

        .confirm-status-button {
          color: transparent;
          position: relative;
        }

        .confirm-status-button::after {
          color: #ffffff;
          content: attr(data-label);
          left: 50%;
          position: absolute;
          top: 50%;
          transform: translate(-50%, -50%);
          white-space: nowrap;
        }

        .tutorial-hint {
          margin-top: 8px;
        }

        .feature-lines {
          display: grid;
          gap: 14px;
        }

        .feature-lines p {
          margin: 0;
        }

        .confirm-action-row {
          align-items: center;
          gap: 14px;
        }

        .confirm-feedback {
          font-size: 15px;
          font-weight: 700;
          line-height: 1.4;
        }

        .confirm-feedback.is-success {
          color: #1e7f73;
        }

        .confirm-feedback.is-error {
          color: #c43c2f;
        }

        .status-chip.success-chip {
          color: #1e7f73;
        }

        .status-chip.error-chip {
          color: #c43c2f;
        }
      `}</style>
    </main>
  );
}
