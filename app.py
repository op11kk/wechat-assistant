from __future__ import annotations

"""
iosbehind — Flask HTTP 网关，业务数据经 Supabase 写入 Postgres。

产品：微信服务号视频数据收集（participants / video_submissions），见 docs/04_data_spec.md。
对象存储：**腾讯云 COS**（见 docs/05_sync_storage.md）。

- 可选 API_SECRET：除 GET /health、GET|HEAD /h5*、CORS 预检、GET|POST /wechat/callback 外需 Bearer 或 X-API-Key。
- 微信明文回调：配置 WECHAT_TOKEN；临时素材拉取需 WECHAT_APP_ID、WECHAT_APP_SECRET；安全模式加解密需自行扩展。
"""

import hashlib
import hmac
import json
import os
import warnings
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from xml.etree.ElementTree import Element

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_file, send_from_directory
from flask_cors import CORS
from postgrest.exceptions import APIError
from supabase import Client, create_client

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
OPENAPI_JSON = BASE_DIR / "openapi.json"
# 与 iosopen 对齐：web/h5/index.html 为上传页；静态资源同目录下相对路径
H5_ROOT = BASE_DIR / "web" / "h5"
H5_INDEX = H5_ROOT / "index.html"
# 默认 dotenv 不覆盖已有环境变量；若系统/终端里残留旧 SUPABASE_URL，会导致连错库。
load_dotenv(BASE_DIR / ".env", override=True)

SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").strip()
SUPABASE_KEY = (os.getenv("SUPABASE_KEY") or "").strip()
if SUPABASE_KEY.startswith("sb_publishable_"):
    warnings.warn(
        "SUPABASE_KEY 当前为 publishable，服务端写库应使用 Project Settings → API 里的 "
        "service_role（secret），不要用 publishable。",
        UserWarning,
        stacklevel=1,
    )
if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError(
        "缺少 SUPABASE_URL 或 SUPABASE_KEY。请复制 .env.example 为 .env 并填写，或导出对应环境变量。"
    )
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def _supabase_project_ref(url: str) -> Optional[str]:
    """从 SUPABASE_URL 解析项目 ref，例如 https://xxx.supabase.co → xxx。"""
    try:
        host = (urllib.parse.urlparse(url).hostname or "").lower()
        suf = ".supabase.co"
        if host.endswith(suf):
            return host[: -len(suf)] or None
    except Exception:
        pass
    return None


API_SECRET = os.getenv("API_SECRET", "").strip()
WECHAT_TOKEN = (os.getenv("WECHAT_TOKEN") or "").strip()
WECHAT_APP_ID = (os.getenv("WECHAT_APP_ID") or "").strip()
WECHAT_APP_SECRET = (os.getenv("WECHAT_APP_SECRET") or "").strip()
COS_SECRET_ID = (os.getenv("COS_SECRET_ID") or "").strip()
COS_SECRET_KEY = (os.getenv("COS_SECRET_KEY") or "").strip()
COS_REGION = (os.getenv("COS_REGION") or "").strip()
COS_BUCKET = (os.getenv("COS_BUCKET") or "").strip()

_wechat_token_lock = threading.Lock()
_wechat_token_cache: dict[str, Any] = {"token": None, "deadline": 0.0}
_cos_client_singleton: Any = None
_cos_client_lock = threading.Lock()

app = Flask(__name__)
CORS(app)


def _cos_env_ok() -> bool:
    return bool(COS_SECRET_ID and COS_SECRET_KEY and COS_REGION and COS_BUCKET)


def _wechat_media_api_ok() -> bool:
    return bool(WECHAT_APP_ID and WECHAT_APP_SECRET)


def _get_cos_client():
    global _cos_client_singleton
    if _cos_client_singleton is not None:
        return _cos_client_singleton
    with _cos_client_lock:
        if _cos_client_singleton is None:
            from qcloud_cos import CosConfig, CosS3Client

            cfg = CosConfig(
                Region=COS_REGION,
                SecretId=COS_SECRET_ID,
                SecretKey=COS_SECRET_KEY,
                Scheme="https",
            )
            _cos_client_singleton = CosS3Client(cfg)
    return _cos_client_singleton


def _wechat_access_token() -> Optional[str]:
    """带内存缓存的 client_credential access_token。"""
    with _wechat_token_lock:
        now = time.time()
        tok = _wechat_token_cache["token"]
        if tok and now < float(_wechat_token_cache["deadline"]):
            return str(tok)
        if not _wechat_media_api_ok():
            return None
        q = urllib.parse.urlencode(
            {
                "grant_type": "client_credential",
                "appid": WECHAT_APP_ID,
                "secret": WECHAT_APP_SECRET,
            }
        )
        url = f"https://api.weixin.qq.com/cgi-bin/token?{q}"
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except (OSError, ValueError, json.JSONDecodeError) as e:
            app.logger.error("wechat token request failed: %s", e)
            return None
        if "access_token" not in payload:
            app.logger.error("wechat token response: %s", payload)
            return None
        token = str(payload["access_token"])
        expires = int(payload.get("expires_in", 7200))
        _wechat_token_cache["token"] = token
        _wechat_token_cache["deadline"] = now + max(120.0, float(expires) - 300.0)
        return token


def _sync_wechat_media_to_cos(submission_id: int, media_id: str, participant_code: str) -> None:
    """后台：微信临时素材下载后写入 COS，并更新 video_submissions。"""
    if not _cos_env_ok() or not _wechat_media_api_ok():
        app.logger.warning("COS sync skipped: COS or WeChat API not configured")
        return
    try:
        token = _wechat_access_token()
        if not token:
            return
        qs = urllib.parse.urlencode({"access_token": token, "media_id": media_id})
        api = f"https://api.weixin.qq.com/cgi-bin/media/get?{qs}"
        req = urllib.request.Request(api)
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read()
            ctype_hdr = resp.headers.get("Content-Type", "") or ""
            ctype = ctype_hdr.split(";")[0].strip().lower()
        if body.startswith(b"{") or "application/json" in ctype:
            app.logger.error(
                "wechat media/get not binary, submission_id=%s body=%s",
                submission_id,
                body[:500],
            )
            return
        ext = ".mp4"
        if ctype in ("video/quicktime",):
            ext = ".mov"
        cos_key = f"uploads/{participant_code}/chat/{submission_id}{ext}"
        mime = ctype if ctype else "video/mp4"
        cli = _get_cos_client()
        cli.put_object(Bucket=COS_BUCKET, Body=body, Key=cos_key, ContentType=mime)
        supabase.table("video_submissions").update(
            {"object_key": cos_key, "size_bytes": len(body), "mime": mime}
        ).eq("id", submission_id).execute()
        app.logger.info(
            "COS sync ok submission_id=%s bytes=%s key=%s",
            submission_id,
            len(body),
            cos_key,
        )
    except urllib.error.HTTPError as e:
        err_b = e.read() if e.fp else b""
        app.logger.error(
            "wechat media/get HTTPError submission_id=%s %s %s",
            submission_id,
            e.code,
            err_b[:400],
        )
    except Exception:
        app.logger.exception("COS sync failed submission_id=%s", submission_id)


def _dt_to_iso_z(dt: datetime) -> str:
    u = dt.astimezone(timezone.utc)
    return u.isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# 鉴权
# ---------------------------------------------------------------------------


def _extract_bearer_or_api_key() -> Optional[str]:
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        t = auth[7:].strip()
        return t if t else None
    xk = (request.headers.get("X-API-Key") or "").strip()
    return xk if xk else None


def _token_matches_secret(token: str) -> bool:
    try:
        a = token.encode("utf-8")
        b = API_SECRET.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return hmac.compare_digest(a, b)


@app.before_request
def enforce_api_auth():
    if request.method == "OPTIONS":
        return None
    if request.path == "/health":
        return None
    if request.path == "/wechat/callback":
        return None
    # 浏览器打开 H5 无法带 Authorization；静态资源走 GET/HEAD /h5 前缀
    _p = request.path
    if request.method in ("GET", "HEAD") and (_p == "/h5" or _p.startswith("/h5/")):
        return None
    if not API_SECRET:
        return None
    token = _extract_bearer_or_api_key()
    if not token or not _token_matches_secret(token):
        return (
            jsonify(
                {
                    "error": "Unauthorized",
                    "detail": "请提供 Authorization: Bearer <API_SECRET> 或 X-API-Key: <API_SECRET>",
                }
            ),
            401,
        )
    return None


# ---------------------------------------------------------------------------
# 元数据
# ---------------------------------------------------------------------------


@app.route("/health", methods=["GET"])
def health():
    # 供运维/前端探测：本仓库仅接 Supabase，无内置 sqlite 路径
    ref = _supabase_project_ref(SUPABASE_URL)
    payload: dict[str, Any] = {"status": "ok", "db": "supabase"}
    if ref:
        payload["supabase_ref"] = ref
    # 本地排障：.env 设 IOSBEHIND_DIAG=1 后重启，可确认是否连错目录/进程
    if os.getenv("IOSBEHIND_DIAG", "").strip().lower() in ("1", "true", "yes"):
        payload["diag"] = {
            "app_py": str(Path(__file__).resolve()),
            "env_file": str((BASE_DIR / ".env").resolve()),
            "env_exists": (BASE_DIR / ".env").is_file(),
            "cwd": os.getcwd(),
            "supabase_host": urllib.parse.urlparse(SUPABASE_URL).hostname,
        }
    return jsonify(payload)


@app.route("/openapi.json", methods=["GET"])
def openapi_spec():
    if not OPENAPI_JSON.is_file():
        return jsonify({"error": "OpenAPI file missing"}), 404
    with OPENAPI_JSON.open(encoding="utf-8") as f:
        spec = json.load(f)
    return jsonify(spec)


@app.route("/h5", methods=["GET", "HEAD"])
@app.route("/h5/", methods=["GET", "HEAD"])
def h5_upload_page():
    """H5 大视频上传页（与 iosopen 行为一致；不受 API_SECRET 拦截）。"""
    if not H5_INDEX.is_file():
        return (
            jsonify(
                {
                    "error": "H5 page not found",
                    "hint": "在仓库根目录放置 web/h5/index.html（可从 iosopen 复制 web/h5）",
                }
            ),
            404,
        )
    resp = send_file(H5_INDEX, mimetype="text/html; charset=utf-8")
    resp.headers["X-Video-Collector-H5"] = "1"
    return resp


@app.route("/h5/<path:subpath>", methods=["GET", "HEAD"])
def h5_static(subpath: str):
    """/h5 下的 js/css 等静态资源。"""
    if not H5_ROOT.is_dir():
        return jsonify({"error": "H5 page not found"}), 404
    if ".." in subpath or subpath.startswith(("/", "\\")):
        return jsonify({"error": "invalid path"}), 400
    target = (H5_ROOT / subpath).resolve()
    try:
        target.relative_to(H5_ROOT.resolve())
    except ValueError:
        return jsonify({"error": "invalid path"}), 400
    if not target.is_file():
        return jsonify({"error": "not found"}), 404
    return send_from_directory(H5_ROOT, subpath)


# ---------------------------------------------------------------------------
# 视频收集
# ---------------------------------------------------------------------------


def _xml_text(el: Optional[Element]) -> Optional[str]:
    if el is None or el.text is None:
        return None
    s = el.text.strip()
    return s if s else None


def _insert_video_submission_row(
    row: dict[str, Any],
) -> tuple[str, Optional[dict], Optional[str]]:
    """
    写入 video_submissions。
    返回 ("inserted", 行, None) | ("duplicate", None, None) | ("error", None, 错误说明)。
    """
    try:
        result = supabase.table("video_submissions").insert(row).execute()
        ins = result.data or []
        if not ins:
            return "error", None, "Insert returned no row"
        app.logger.info(
            "video_submission inserted id=%s source=%s",
            ins[0].get("id"),
            row.get("source"),
        )
        return "inserted", ins[0], None
    except APIError as e:
        err_s = str(e).lower()
        if "duplicate" in err_s or "unique" in err_s or "23505" in err_s:
            app.logger.info(
                "video_submission dedupe wechat_media_id=%s", row.get("wechat_media_id")
            )
            return "duplicate", None, None
        app.logger.error("video_submission insert: %s", e)
        return "error", None, str(e)


def _ingest_chat_video_wechat(
    openid: str,
    media_id: str,
    *,
    user_comment: Optional[str] = None,
) -> None:
    """服务号会话内用户发送 video / shortvideo 时入库；若已配置 COS 与微信 AppSecret，后台线程转存 COS。"""
    pr = (
        supabase.table("participants")
        .select("id, participant_code")
        .eq("wechat_openid", openid)
        .limit(1)
        .execute()
    )
    if not pr.data:
        app.logger.info(
            "chat video skipped: no participant for openid prefix=%s",
            (openid[:6] + "…") if len(openid) > 6 else openid,
        )
        return
    pid = pr.data[0]["id"]
    code = str(pr.data[0]["participant_code"])
    row: dict[str, Any] = {
        "participant_id": pid,
        "participant_code": code,
        "source": "chat",
        "object_key": f"wechat/pending/{media_id}",
        "wechat_media_id": media_id,
        "user_comment": user_comment,
        "review_status": "pending",
    }
    status, ins_row, _ins_err = _insert_video_submission_row(row)
    if status == "error":
        app.logger.error("chat video insert failed (see log for APIError)")
        return
    if (
        status == "inserted"
        and ins_row is not None
        and _cos_env_ok()
        and _wechat_media_api_ok()
    ):
        sid = int(ins_row["id"])
        threading.Thread(
            target=_sync_wechat_media_to_cos,
            args=(sid, media_id, code),
            daemon=True,
        ).start()


def _process_wechat_inbound_xml(root: Element) -> None:
    msg_type_el = root.find("MsgType")
    msg_type = (_xml_text(msg_type_el) or "").lower()
    if msg_type in ("video", "shortvideo"):
        openid = _xml_text(root.find("FromUserName"))
        media_id = _xml_text(root.find("MediaId"))
        if not openid or not media_id:
            app.logger.warning("wechat %s missing FromUserName or MediaId", msg_type)
            return
        user_comment = _xml_text(root.find("Description"))
        _ingest_chat_video_wechat(openid, media_id, user_comment=user_comment)
        return
    app.logger.info("wechat MsgType=%s (no ingest)", msg_type or "?")


def _next_participant_code() -> str:
    r = (
        supabase.table("participants")
        .select("participant_code")
        .order("id", desc=True)
        .limit(1)
        .execute()
    )
    n = 1
    if r.data:
        try:
            n = int(str(r.data[0].get("participant_code", "0"))) + 1
        except (TypeError, ValueError):
            n = 1
    if n > 999_999:
        n = 1
    return f"{n:06d}"


@app.route("/wechat/callback", methods=["GET", "POST"])
def wechat_callback():
    if request.method == "GET":
        if not WECHAT_TOKEN:
            return jsonify({"error": "WECHAT_TOKEN not configured"}), 503
        signature = request.args.get("signature", "")
        timestamp = request.args.get("timestamp", "")
        nonce = request.args.get("nonce", "")
        echostr = request.args.get("echostr", "")
        tmp = "".join(sorted([WECHAT_TOKEN, timestamp, nonce]))
        if hashlib.sha1(tmp.encode("utf-8")).hexdigest() != signature:
            return "Forbidden", 403
        return echostr, 200, {"Content-Type": "text/plain; charset=utf-8"}
    raw = request.data or b""
    if not raw:
        return "success", 200, {"Content-Type": "text/plain; charset=utf-8"}
    try:
        root = ET.fromstring(raw)
        _process_wechat_inbound_xml(root)
    except ET.ParseError:
        app.logger.warning("wechat XML parse error")
    return "success", 200, {"Content-Type": "text/plain; charset=utf-8"}


@app.route("/participants", methods=["POST"])
def create_participant():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON body"}), 400
    openid = str(data.get("wechat_openid") or "").strip()
    real_name = str(data.get("real_name") or "").strip()
    phone = str(data.get("phone") or "").strip()
    if not openid or not real_name or not phone:
        return (
            jsonify(
                {
                    "error": "Missing fields",
                    "detail": "wechat_openid, real_name, phone required",
                }
            ),
            400,
        )
    exist = (
        supabase.table("participants")
        .select("*")
        .eq("wechat_openid", openid)
        .limit(1)
        .execute()
    )
    if exist.data:
        return (
            jsonify(
                {
                    "error": "Participant already exists",
                    "participant": exist.data[0],
                }
            ),
            409,
        )
    extra = data.get("extra")
    if extra is not None and not isinstance(extra, dict):
        return jsonify({"error": "extra must be an object"}), 400
    status = str(data.get("status") or "active").strip()
    if status not in ("active", "paused", "withdrawn"):
        return jsonify({"error": "invalid status"}), 400

    for _ in range(32):
        code = _next_participant_code()
        row = {
            "wechat_openid": openid,
            "real_name": real_name,
            "phone": phone,
            "participant_code": code,
            "status": status,
            "extra": extra if isinstance(extra, dict) else {},
        }
        try:
            result = supabase.table("participants").insert(row).execute()
            ins = result.data or []
            if not ins:
                return jsonify({"error": "Insert returned no row"}), 500
            return jsonify({"message": "ok", "participant": ins[0]}), 201
        except APIError as e:
            err_s = str(e).lower()
            if "duplicate" in err_s or "unique" in err_s or "23505" in err_s:
                continue
            return jsonify({"error": "Failed to create participant", "detail": str(e)}), 500
    return jsonify({"error": "Could not allocate participant_code"}), 500


@app.route("/participants/by_openid", methods=["GET"])
def participant_by_openid():
    oid = (request.args.get("wechat_openid") or "").strip()
    if not oid:
        return jsonify({"error": "wechat_openid query param required"}), 400
    r = supabase.table("participants").select("*").eq("wechat_openid", oid).limit(1).execute()
    if not r.data:
        return jsonify({"error": "not found", "hint": oid}), 404
    return jsonify({"participant": r.data[0]})


@app.route("/participants/code/<participant_code>", methods=["GET"])
def participant_by_code(participant_code: str):
    code = (participant_code or "").strip()
    if not code:
        return jsonify({"error": "invalid code"}), 400
    r = supabase.table("participants").select("*").eq("participant_code", code).limit(1).execute()
    if not r.data:
        return jsonify({"error": "not found", "hint": code}), 404
    return jsonify({"participant": r.data[0]})


@app.route("/upload/presign", methods=["POST"])
def upload_presign():
    """签发腾讯云 COS PUT 预签名 URL（H5 大视频直传）。"""
    if not _cos_env_ok():
        return (
            jsonify(
                {
                    "error": "COS not configured",
                    "detail": "需要 COS_SECRET_ID、COS_SECRET_KEY、COS_REGION、COS_BUCKET，见 .env.example",
                }
            ),
            503,
        )
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON body"}), 400
    code = str(data.get("participant_code") or "").strip()
    oid = str(data.get("wechat_openid") or "").strip()
    if not code or not oid:
        return (
            jsonify(
                {"error": "Missing fields", "detail": "participant_code, wechat_openid required"}
            ),
            400,
        )
    pr = (
        supabase.table("participants")
        .select("id")
        .eq("participant_code", code)
        .eq("wechat_openid", oid)
        .limit(1)
        .execute()
    )
    if not pr.data:
        return (
            jsonify(
                {
                    "error": "Participant mismatch",
                    "detail": "数据库中不存在该 participant_code 与 wechat_openid 的组合，请先 POST /participants 登记",
                }
            ),
            404,
        )
    content_type = str(data.get("content_type") or "video/mp4").strip() or "video/mp4"
    key = f"uploads/{code}/h5/{uuid.uuid4().hex}.mp4"
    expires = 600
    try:
        cli = _get_cos_client()
        signed_url = cli.get_presigned_url(
            Bucket=COS_BUCKET,
            Key=key,
            Method="PUT",
            Expired=expires,
            Headers={"Content-Type": content_type},
        )
    except Exception as e:
        app.logger.exception("COS presign failed")
        return jsonify({"error": "presign failed", "detail": str(e)}), 500
    return (
        jsonify(
            {
                "method": "PUT",
                "url": signed_url,
                "headers": {"Content-Type": content_type},
                "object_key": key,
                "expires_in": expires,
                "storage": "tencent_cos",
            }
        ),
        200,
    )


@app.route("/upload/complete", methods=["POST"])
def upload_complete():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON body"}), 400
    req = ("participant_code", "wechat_openid", "source", "object_key")
    missing = [k for k in req if not str(data.get(k) or "").strip()]
    if missing:
        return jsonify({"error": "Missing fields", "detail": ", ".join(missing)}), 400
    code = str(data["participant_code"]).strip()
    oid = str(data["wechat_openid"]).strip()
    source = str(data["source"]).strip().lower()
    object_key = str(data["object_key"]).strip()
    if source not in ("chat", "h5"):
        return jsonify({"error": "source must be chat or h5"}), 400
    row: dict = {
        "participant_id": 0,
        "participant_code": code,
        "source": source,
        "object_key": object_key,
        "wechat_media_id": (str(data["wechat_media_id"]).strip() if data.get("wechat_media_id") else None),
        "file_name": (str(data["file_name"]).strip() if data.get("file_name") else None),
        "size_bytes": data.get("size_bytes"),
        "mime": (str(data["mime"]).strip() if data.get("mime") else None),
        "duration_sec": data.get("duration_sec"),
        "user_comment": (str(data["user_comment"]).strip() if data.get("user_comment") else None),
        "review_status": "pending",
    }
    if row["size_bytes"] is not None:
        try:
            row["size_bytes"] = int(row["size_bytes"])
        except (TypeError, ValueError):
            return jsonify({"error": "size_bytes must be integer"}), 400
    try:
        pr = (
            supabase.table("participants")
            .select("id")
            .eq("participant_code", code)
            .eq("wechat_openid", oid)
            .limit(1)
            .execute()
        )
        if not pr.data:
            return (
                jsonify(
                    {
                        "error": "Participant mismatch",
                        "detail": "No row for this participant_code and wechat_openid",
                    }
                ),
                404,
            )
        participant_id = pr.data[0]["id"]
        row["participant_id"] = participant_id
        status, submission, insert_err = _insert_video_submission_row(row)
        if status == "error":
            return (
                jsonify(
                    {
                        "error": "Failed to insert submission",
                        "detail": insert_err or "unknown",
                    }
                ),
                500,
            )
        if status == "inserted" and submission is not None:
            return jsonify({"message": "ok", "submission": submission}), 201
        if status == "duplicate":
            if row.get("wechat_media_id"):
                r = (
                    supabase.table("video_submissions")
                    .select("*")
                    .eq("wechat_media_id", row["wechat_media_id"])
                    .limit(1)
                    .execute()
                )
            else:
                r = (
                    supabase.table("video_submissions")
                    .select("*")
                    .eq("participant_id", participant_id)
                    .eq("object_key", object_key)
                    .limit(1)
                    .execute()
                )
            if r.data:
                return jsonify(
                    {"message": "ok", "submission": r.data[0], "deduplicated": True}
                ), 200
            return jsonify({"message": "ok", "deduplicated": True}), 200
        return jsonify({"error": "Unexpected insert state"}), 500
    except APIError as e:
        return jsonify({"error": "Supabase APIError", "detail": str(e)}), 500
    except Exception as e:
        app.logger.exception("upload/complete")
        return jsonify({"error": "upload/complete failed", "detail": str(e)}), 500


@app.route("/admin/submissions", methods=["GET"])
def admin_list_submissions():
    status_filter = (request.args.get("review_status") or "").strip()
    try:
        limit = int(request.args.get("limit", "50"))
    except ValueError:
        return jsonify({"error": "limit must be integer"}), 400
    limit = max(1, min(limit, 200))
    q = supabase.table("video_submissions").select("*")
    if status_filter:
        if status_filter not in ("pending", "approved", "rejected"):
            return jsonify({"error": "invalid review_status"}), 400
        q = q.eq("review_status", status_filter)
    try:
        result = q.order("id", desc=True).limit(limit).execute()
        return jsonify({"submissions": result.data or []})
    except APIError as e:
        return jsonify({"error": "Query failed", "detail": str(e)}), 500


@app.route("/admin/submissions/<int:submission_id>", methods=["PATCH"])
def admin_patch_submission(submission_id: int):
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not data:
        return jsonify({"error": "Invalid or empty JSON body"}), 400
    patch: dict = {}
    if "review_status" in data:
        rs = str(data["review_status"] or "").strip()
        if rs not in ("pending", "approved", "rejected"):
            return jsonify({"error": "invalid review_status"}), 400
        patch["review_status"] = rs
    if "reject_reason" in data:
        patch["reject_reason"] = data["reject_reason"]
    if not patch:
        return jsonify({"error": "No patchable fields", "detail": "review_status, reject_reason"}), 400
    if patch.get("review_status") in ("approved", "rejected"):
        patch["reviewed_at"] = _dt_to_iso_z(datetime.now(tz=timezone.utc))
    try:
        result = (
            supabase.table("video_submissions")
            .update(patch)
            .eq("id", submission_id)
            .execute()
        )
        rows = result.data or []
        if not rows:
            return jsonify({"error": "submission not found", "hint": submission_id}), 404
        return jsonify({"message": "ok", "submission": rows[0]})
    except APIError as e:
        return jsonify({"error": "Update failed", "detail": str(e)}), 500


if __name__ == "__main__":
    _ref = _supabase_project_ref(SUPABASE_URL)
    _host = urllib.parse.urlparse(SUPABASE_URL).hostname or "?"
    try:
        _port = int((os.getenv("FLASK_PORT") or os.getenv("PORT") or "5000").strip())
    except ValueError:
        _port = 5000
    # debug 关则不会启 reloader；debug 开时可用 FLASK_USE_RELOADER=0 关掉热重载子进程
    _flask_debug = os.getenv("FLASK_DEBUG", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )
    _reload = _flask_debug and (
        os.getenv("FLASK_USE_RELOADER", "1").strip().lower() not in ("0", "false", "no", "off")
    )
    print(
        f"[iosbehind] 监听端口 {_port}；若与 curl /health 不一致，说明该端口上不是本进程或读错 .env\n"
        f"  app.py={Path(__file__).resolve()}\n"
        f"  env_file={(BASE_DIR / '.env').resolve()}  exists={(BASE_DIR / '.env').is_file()}\n"
        f"  supabase_host={_host!r}  supabase_ref={_ref!r}\n"
        f"  FLASK_DEBUG={_flask_debug}  use_reloader={_reload}\n"
        "  netstat 若仍有两个 LISTENING：先 taskkill /IM python.exe /F 清干净再启动；仍不行设 FLASK_DEBUG=0\n"
        f"  -> curl http://127.0.0.1:{_port}/health",
        flush=True,
    )
    app.run(host="0.0.0.0", port=_port, debug=_flask_debug, use_reloader=_reload)
