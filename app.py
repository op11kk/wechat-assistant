from __future__ import annotations

"""
iosbehind — Flask HTTP 网关，业务数据经 Supabase Python 客户端写入 Postgres。

- 业务会话标识：sessions.session_id（TEXT，与 iOS UUID 一致）；sessions.id 为表自增主键。
- 传感器行：sensor_data.session_id 必须已存在于 sessions。
- 可选 API_SECRET：除 GET /health 与 CORS 预检外需 Bearer 或 X-API-Key。
- 时间：支持 ISO8601 与 Unix 秒/毫秒；可选 timestamp_is_elapsed 表示相对 sessions.start_time 的秒数。
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
from supabase import create_client, Client
from postgrest.exceptions import APIError
from typing import Any, Optional
from pathlib import Path
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
import hmac
import json
import os

# ---------------------------------------------------------------------------
# 配置：.env、Supabase 客户端、Flask 应用
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
OPENAPI_JSON = BASE_DIR / "openapi.json"
load_dotenv(BASE_DIR / ".env")

SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").strip()
SUPABASE_KEY = (os.getenv("SUPABASE_KEY") or "").strip()
if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError(
        "缺少 SUPABASE_URL 或 SUPABASE_KEY。请复制 .env.example 为 .env 并填写，或导出对应环境变量。"
    )
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

API_SECRET = os.getenv("API_SECRET", "").strip()

app = Flask(__name__)
CORS(app)  # 浏览器跨域；真机 native 请求不依赖此项，但保留无害


# ---------------------------------------------------------------------------
# 鉴权（API_SECRET 非空时启用）
# ---------------------------------------------------------------------------


def _extract_bearer_or_api_key() -> Optional[str]:
    """从 Authorization: Bearer 或 X-API-Key 取出令牌原文。"""
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        t = auth[7:].strip()
        return t if t else None
    xk = (request.headers.get("X-API-Key") or "").strip()
    return xk if xk else None


def _token_matches_secret(token: str) -> bool:
    """与 API_SECRET 做恒定时间比较，降低时序旁路风险。"""
    try:
        a = token.encode("utf-8")
        b = API_SECRET.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return hmac.compare_digest(a, b)


@app.before_request
def enforce_api_auth():
    """全局前置：未配置 API_SECRET 时不拦截；OPTIONS 留给 CORS；/health 给探活。"""
    if request.method == "OPTIONS":
        return None
    if request.path == "/health":
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
# 传感器与分页常量
# ---------------------------------------------------------------------------

REQUIRED_SENSOR_FIELDS = ("session_id", "sensor_type", "x", "y", "z", "timestamp")
MAX_BATCH_SIZE = 500
DEFAULT_SAMPLE_LIMIT = 500
MAX_SAMPLE_LIMIT = 5000

# 数值时间 >= 该阈值视为「Unix 纪元秒」（>1e12 会先按毫秒折算）；小于阈值在绝对时间模式下报错，
# 在 timestamp_is_elapsed=true 时表示「相对 sessions.start_time 的秒数」。
_UNIX_SEC_THRESHOLD = 1_000_000_000.0


# ---------------------------------------------------------------------------
# 时间解析与归一化（写入 TIMESTAMPTZ 前统一成 ISO 字符串供 PostgREST）
# ---------------------------------------------------------------------------


def _parse_iso_to_utc_aware(s: str) -> datetime:
    """将 API/数据库返回的 ISO 字符串解析为带时区的 UTC datetime。"""
    t = s.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(t)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _dt_to_iso_z(dt: datetime) -> str:
    """UTC 时间转 ISO 字符串，末尾用 Z 便于与前端约定一致。"""
    u = dt.astimezone(timezone.utc)
    return u.isoformat().replace("+00:00", "Z")


def normalize_absolute_timestamptz(value: Any, field: str) -> str:
    """ISO8601 字符串原样（trim）；数值视为 Unix 秒，>1e12 视为毫秒。用于 start_time / end_time 等绝对时间。"""
    if isinstance(value, str):
        s = value.strip()
        if not s:
            raise ValueError(f"{field} must be non-empty")
        return s
    if isinstance(value, bool):
        raise ValueError(f"{field}: unexpected boolean")
    if isinstance(value, (int, float)):
        x = float(value)
        if x > 10_000_000_000:
            x /= 1000.0
        if x >= _UNIX_SEC_THRESHOLD:
            return _dt_to_iso_z(datetime.fromtimestamp(x, tz=timezone.utc))
        raise ValueError(
            f"{field}: numeric value too small for Unix epoch; use seconds since 1970 (e.g. Date.timeIntervalSince1970) "
            f"or ISO8601 string. CACurrentMediaTime alone is not wall time."
        )
    raise ValueError(f"{field}: expected string or number")


def normalize_optional_absolute_timestamptz(value: Any, field: str) -> Optional[str]:
    """可选绝对时间；None 保持 None（如 end_time 未传）。"""
    if value is None:
        return None
    return normalize_absolute_timestamptz(value, field)


def normalize_since_query_param(raw: str) -> str:
    """GET .../samples?since= 支持 ISO 或 Unix 秒/毫秒数字字符串。"""
    s = raw.strip()
    if not s:
        return s
    try:
        n = float(s)
        if n > 10_000_000_000:
            n /= 1000.0
        if n >= _UNIX_SEC_THRESHOLD:
            return _dt_to_iso_z(datetime.fromtimestamp(n, tz=timezone.utc))
    except ValueError:
        pass
    return s


def _fetch_session_start_time_iso(session_id: str) -> Optional[str]:
    """读取已注册会话的 start_time（Supabase 返回的字符串），供 elapsed 模式叠加相对秒数。"""
    r = supabase.table("sessions").select("start_time").eq("session_id", session_id).limit(1).execute()
    if not r.data:
        return None
    st = r.data[0].get("start_time")
    return str(st) if st is not None else None


def normalize_sensor_timestamp(
    raw: Any,
    *,
    session_id: str,
    timestamp_is_elapsed: bool,
    session_start_iso: Optional[str],
) -> tuple[Optional[str], Optional[tuple]]:
    """成功 (iso, None)；失败 (None, (jsonify(...), status))。"""
    if timestamp_is_elapsed:
        if not isinstance(raw, (int, float)):
            return None, (
                jsonify(
                    {
                        "error": "timestamp must be a number when timestamp_is_elapsed is true",
                        "detail": "Use seconds since session wall start (e.g. CACurrentMediaTime - t0Media).",
                    }
                ),
                400,
            )
        if session_start_iso is None:
            return None, (
                jsonify({"error": "session start_time missing", "hint": session_id}),
                500,
            )
        try:
            base = _parse_iso_to_utc_aware(session_start_iso)
        except (ValueError, TypeError):
            return None, (
                jsonify(
                    {
                        "error": "Cannot parse session start_time for elapsed mode",
                        "detail": str(session_start_iso),
                    }
                ),
                500,
            )
        dt = base + timedelta(seconds=float(raw))
        return _dt_to_iso_z(dt), None

    try:
        return normalize_absolute_timestamptz(raw, "timestamp"), None
    except ValueError as e:
        return None, (jsonify({"error": str(e)}), 400)


def _truthy_flag(v: Any) -> bool:
    """兼容 JSON 里 true / "true" / 1 等形式的布尔开关。"""
    if v is True:
        return True
    if isinstance(v, str) and v.lower() in ("1", "true", "yes"):
        return True
    if v == 1:
        return True
    return False


# ---------------------------------------------------------------------------
# sessions 表：创建时可写字段 / PATCH 允许字段（与数据库列名一致）
# ---------------------------------------------------------------------------

SESSION_REQUIRED_CREATE = (
    "session_id",
    "user_selected_mode",
    "capture_mode",
    "start_time",
)
SESSION_OPTIONAL_CREATE = (
    "device_model",
    "ios_version",
    "app_version",
    "end_time",
    "duration_ms",
    "total_rgb_frames",
    "total_pose_samples",
    "total_imu_samples",
    "total_depth_frames",
    "upload_status",
)
SESSION_PATCHABLE = (
    "end_time",
    "duration_ms",
    "total_rgb_frames",
    "total_pose_samples",
    "total_imu_samples",
    "total_depth_frames",
    "upload_status",
    "user_selected_mode",
    "capture_mode",
    "device_model",
    "ios_version",
    "app_version",
    "start_time",
)


# ---------------------------------------------------------------------------
# 会话存在性校验与 sensor_data 行构造
# ---------------------------------------------------------------------------


def _session_not_found_response(session_id: str):
    """统一 404 结构，提示先 POST /sessions。"""
    return (
        jsonify(
            {
                "error": "Session not found",
                "detail": "请先用 POST /sessions 注册该会话",
                "hint": session_id,
            }
        ),
        404,
    )


def _require_session_exists(session_id: str):
    """session_id 为业务 UUID 字符串，对应 sessions.session_id 与 sensor_data.session_id。"""
    r = supabase.table("sessions").select("id").eq("session_id", session_id).limit(1).execute()
    if not r.data:
        return _session_not_found_response(session_id)
    return None


def _sensor_row_with_ts(data: dict, timestamp_iso: str) -> dict:
    """插入 sensor_data 的一行；timestamp 已归一化为 ISO。"""
    return {
        "session_id": data["session_id"],
        "sensor_type": data["sensor_type"],
        "x": data["x"],
        "y": data["y"],
        "z": data["z"],
        "timestamp": timestamp_iso,
    }


def _validate_sensor_item(item, index: Optional[int] = None):
    """校验单条上传体是否含必填键；index 非空时错误信息带上下标。"""
    if not isinstance(item, dict):
        msg = "Each item must be an object"
        if index is not None:
            msg = f"Invalid item at index {index}"
        return msg
    missing = [f for f in REQUIRED_SENSOR_FIELDS if f not in item]
    if missing:
        prefix = f"Item at index {index}: " if index is not None else ""
        return f"{prefix}Missing fields: {', '.join(missing)}"
    return None


def _build_session_insert_row(data: dict) -> tuple[Optional[dict], Optional[tuple]]:
    """
    组装 POST /sessions 的 insert 字典。
    成功返回 (row, None)；失败返回 (None, (jsonify(...), status))。
    """
    missing = [k for k in SESSION_REQUIRED_CREATE if k not in data or data[k] is None]
    if missing:
        return None, (jsonify({"error": "Missing fields", "detail": ", ".join(missing)}), 400)
    row: dict = {}
    try:
        sid = str(data["session_id"]).strip()
        row["session_id"] = sid
        um = data["user_selected_mode"]
        row["user_selected_mode"] = um.strip() if isinstance(um, str) else um
        cm = data["capture_mode"]
        row["capture_mode"] = cm.strip() if isinstance(cm, str) else cm
        row["start_time"] = normalize_absolute_timestamptz(data["start_time"], "start_time")
    except ValueError as e:
        return None, (jsonify({"error": str(e)}), 400)
    if not row["session_id"]:
        return None, (jsonify({"error": "session_id must be non-empty"}), 400)
    for k in SESSION_OPTIONAL_CREATE:
        if k not in data or data[k] is None:
            continue
        if k in ("end_time",):
            try:
                row[k] = normalize_optional_absolute_timestamptz(data[k], k)
            except ValueError as e:
                return None, (jsonify({"error": str(e)}), 400)
        else:
            row[k] = data[k]
    return row, None


# ---------------------------------------------------------------------------
# 路由：元数据与健康
# ---------------------------------------------------------------------------


@app.route('/health', methods=['GET'])
def health():
    """负载均衡/探活；不查库。"""
    return jsonify({"status": "ok"})


@app.route("/openapi.json", methods=["GET"])
def openapi_spec():
    """返回仓库内 openapi.json，供 Swagger / 代码生成使用。"""
    if not OPENAPI_JSON.is_file():
        return jsonify({"error": "OpenAPI file missing"}), 404
    with OPENAPI_JSON.open(encoding="utf-8") as f:
        spec = json.load(f)
    return jsonify(spec)


# ---------------------------------------------------------------------------
# 路由：传感器写入（须先注册 sessions）
# ---------------------------------------------------------------------------


@app.route('/upload_sensor', methods=['POST'])
def upload_sensor():
    """单条写入 sensor_data；可选 JSON 字段 timestamp_is_elapsed。"""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON body"}), 400
    err = _validate_sensor_item(data)
    if err:
        return jsonify({"error": err}), 400
    missing = _require_session_exists(data["session_id"])
    if missing:
        return missing

    # 相对时间模式：timestamp 为秒数，叠加到该会话的 sessions.start_time 墙钟时刻
    ts_flag = _truthy_flag(data.get("timestamp_is_elapsed"))
    start_iso = _fetch_session_start_time_iso(data["session_id"]) if ts_flag else None
    ts_iso, terr = normalize_sensor_timestamp(
        data["timestamp"],
        session_id=data["session_id"],
        timestamp_is_elapsed=ts_flag,
        session_start_iso=start_iso,
    )
    if terr:
        return terr

    result = supabase.table("sensor_data").insert(_sensor_row_with_ts(data, ts_iso)).execute()
    return jsonify({"message": "ok", "id": result.data[0]["id"]}), 201


@app.route('/upload_sensor_batch', methods=['POST'])
def upload_sensor_batch():
    """批量写入；全表 session_id 须一致。顶层 timestamp_is_elapsed 可被单条同名字段覆盖。"""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON body"}), 400
    if "items" not in data:
        return jsonify({"error": "Missing items"}), 400
    items = data["items"]
    if not isinstance(items, list):
        return jsonify({"error": "items must be a list"}), 400
    if len(items) == 0:
        return jsonify({"error": "items is empty"}), 400
    if len(items) > MAX_BATCH_SIZE:
        return jsonify({"error": f"Maximum {MAX_BATCH_SIZE} items per request"}), 400

    first_sid = items[0].get("session_id")
    if not isinstance(first_sid, str) or not first_sid.strip():
        return jsonify({"error": "Invalid session_id in first item"}), 400
    first_sid = first_sid.strip()
    for i, item in enumerate(items):
        err = _validate_sensor_item(item, i)
        if err:
            return jsonify({"error": err}), 400
        sid = item.get("session_id")
        if sid != first_sid:
            return (
                jsonify(
                    {"error": "All items must use the same session_id", "detail": f"mismatch at index {i}"}
                ),
                400,
            )
    missing = _require_session_exists(first_sid)
    if missing:
        return missing

    batch_ts_flag = _truthy_flag(data.get("timestamp_is_elapsed"))
    # 任一条要用 elapsed，就拉一次 session.start_time，避免循环里重复查库
    need_start = batch_ts_flag or any(
        _truthy_flag(it.get("timestamp_is_elapsed")) if isinstance(it, dict) and "timestamp_is_elapsed" in it else False
        for it in items
    )
    start_iso = _fetch_session_start_time_iso(first_sid) if need_start else None

    rows = []
    for item in items:
        item_flag = (
            _truthy_flag(item["timestamp_is_elapsed"])
            if isinstance(item, dict) and "timestamp_is_elapsed" in item
            else batch_ts_flag
        )
        ts_iso, terr = normalize_sensor_timestamp(
            item["timestamp"],
            session_id=first_sid,
            timestamp_is_elapsed=item_flag,
            session_start_iso=start_iso if item_flag else None,
        )
        if terr:
            return terr
        rows.append(_sensor_row_with_ts(item, ts_iso))

    result = supabase.table("sensor_data").insert(rows).execute()
    inserted = result.data or []
    ids = [r["id"] for r in inserted if isinstance(r, dict) and "id" in r]
    return jsonify({"message": "ok", "count": len(rows), "ids": ids}), 201


# ---------------------------------------------------------------------------
# 路由：会话列表、创建、采样分页、更新与删除
# ---------------------------------------------------------------------------


@app.route('/sessions', methods=['GET'])
def list_sessions():
    """读视图 session_stats（须已在 Supabase 执行 schema_extras.sql）。"""
    try:
        result = (
            supabase.table("session_stats")
            .select("*")
            .order("start_time", desc=True)
            .execute()
        )
        return jsonify({"sessions": result.data or []})
    except APIError as e:
        return jsonify(
            {
                "error": "Failed to load sessions",
                "detail": str(e),
                "hint": "在 Supabase 执行 schema_extras.sql（sessions 与 sensor_data 关联的 session_stats 视图）",
            }
        ), 503


@app.route("/sessions", methods=["POST"])
def create_session():
    """插入 sessions 一行；session_id 重复时尝试映射 409。"""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON body"}), 400
    row, bad = _build_session_insert_row(data)
    if bad:
        return bad
    assert row is not None
    try:
        result = supabase.table("sessions").insert(row).execute()
        inserted = result.data or []
        if not inserted:
            return jsonify({"error": "Insert returned no row"}), 500
        return jsonify({"message": "ok", "session": inserted[0]}), 201
    except APIError as e:
        err_s = str(e).lower()
        if "duplicate" in err_s or "unique" in err_s or "23505" in err_s:
            return jsonify({"error": "Session already exists", "detail": str(e)}), 409
        return jsonify({"error": "Failed to create session", "detail": str(e)}), 500


@app.route('/sessions/<path:session_id>/samples', methods=['GET'])
def list_session_samples(session_id: str):
    """
    分页拉取 sensor_data。
    路由须注册在 DELETE /sessions/<id> 之前，避免 path 把「xxx/samples」吞成 session_id。
    游标：下一页传上一页返回的 next_cursor 作为查询参数 after_id。
    """
    sid = (session_id or "").strip()
    if not sid:
        return jsonify({"error": "Invalid session_id"}), 400

    raw_limit = request.args.get("limit", str(DEFAULT_SAMPLE_LIMIT))
    try:
        limit = int(raw_limit)
    except ValueError:
        return jsonify({"error": "limit must be an integer"}), 400
    limit = max(1, min(limit, MAX_SAMPLE_LIMIT))

    since = request.args.get("since")
    if since is not None:
        since = since.strip()
        if since == "":
            since = None
        else:
            since = normalize_since_query_param(since)

    after_id_raw = request.args.get("after_id")
    after_id: Optional[int] = None
    if after_id_raw is not None and after_id_raw != "":
        try:
            after_id = int(after_id_raw)
        except ValueError:
            return jsonify({"error": "after_id must be an integer"}), 400

    missing = _require_session_exists(sid)
    if missing:
        return missing

    try:
        q = supabase.table("sensor_data").select("*").eq("session_id", sid)
        if since is not None:
            q = q.gte("timestamp", since)
        if after_id is not None:
            q = q.gt("id", after_id)
        result = q.order("id", desc=False).limit(limit).execute()
        items = result.data or []
        next_cursor = None
        has_more = False
        if items and len(items) == limit:
            last = items[-1]
            if isinstance(last, dict) and "id" in last:
                next_cursor = last["id"]
                has_more = True
        return jsonify(
            {
                "session_id": sid,
                "items": items,
                "count": len(items),
                "next_cursor": next_cursor,
                "has_more": has_more,
            }
        )
    except APIError as e:
        return jsonify({"error": "Query failed", "detail": str(e)}), 500


@app.route("/sessions/<path:session_id>", methods=["PATCH", "DELETE"])
def session_by_text_id(session_id: str):
    """按业务 session_id（TEXT）更新或删除 sessions 行；path 支持含斜杠的编码路径。"""
    sid = (session_id or "").strip()
    if not sid:
        return jsonify({"error": "Invalid session_id"}), 400
    if request.method == "DELETE":
        return _delete_session_by_text_id(sid)
    return _patch_session_by_text_id(sid)


def _delete_session_by_text_id(sid: str):
    """删除 sessions；若 DB 有 ON DELETE CASCADE 则一并删 sensor_data。"""
    try:
        result = (
            supabase.table("sessions")
            .delete(count="exact", returning="minimal")
            .eq("session_id", sid)
            .execute()
        )
        n = result.count if result.count is not None else 0
        if n == 0:
            return jsonify({"error": "Session not found", "hint": sid}), 404
        return jsonify({"message": "ok", "session_id": sid})
    except APIError as e:
        return jsonify({"error": "Delete failed", "detail": str(e)}), 500


def _patch_session_by_text_id(sid: str):
    """部分更新；start_time/end_time 走与创建相同的时间归一化。注意：postgrest 的 update 链上不能接 .select()。"""
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not data:
        return jsonify({"error": "Invalid or empty JSON body"}), 400
    patch = {k: data[k] for k in SESSION_PATCHABLE if k in data}
    if not patch:
        return jsonify({"error": "No patchable fields", "detail": ", ".join(SESSION_PATCHABLE)}), 400
    for tk in ("start_time", "end_time"):
        if tk not in patch:
            continue
        try:
            if tk == "end_time":
                patch[tk] = normalize_optional_absolute_timestamptz(patch[tk], tk)
            else:
                patch[tk] = normalize_absolute_timestamptz(patch[tk], tk)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
    try:
        # postgrest：update().eq() 返回的 builder 无 .select()；默认 Prefer: return=representation 已带回更新行
        result = supabase.table("sessions").update(patch).eq("session_id", sid).execute()
        rows = result.data or []
        if not rows:
            return jsonify({"error": "Session not found", "hint": sid}), 404
        return jsonify({"message": "ok", "session": rows[0]})
    except APIError as e:
        return jsonify({"error": "Update failed", "detail": str(e)}), 500


if __name__ == '__main__':
    # 0.0.0.0：局域网内手机可通过 Mac IP + 端口访问；生产请换 gunicorn 等并关闭 debug
    app.run(host='0.0.0.0', port=5000, debug=True)
