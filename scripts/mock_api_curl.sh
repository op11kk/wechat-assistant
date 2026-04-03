#!/usr/bin/env bash
# 假数据联调：先启动 Flask（python app.py），再在本机执行本脚本。
# 用法：
#   chmod +x scripts/mock_api_curl.sh
#   ./scripts/mock_api_curl.sh
# 若 .env 里设置了 API_SECRET：
#   export API_SECRET='你的密钥'
#   ./scripts/mock_api_curl.sh
# 可选：BASE=http://127.0.0.1:5000 SESSION_ID=my-uuid ./scripts/mock_api_curl.sh

set -euo pipefail

BASE="${BASE:-http://127.0.0.1:5000}"
SESSION_ID="${SESSION_ID:-mock-$(date -u +%Y%m%dT%H%M%SZ)-$$}"

AUTH=()
if [[ -n "${API_SECRET:-}" ]]; then
  AUTH=(-H "Authorization: Bearer ${API_SECRET}")
fi

echo "==> BASE=$BASE SESSION_ID=$SESSION_ID"
echo

echo "==> GET /health"
curl -sS "${AUTH[@]}" "$BASE/health" | python -m json.tool 2>/dev/null || curl -sS "${AUTH[@]}" "$BASE/health"
echo
echo

echo "==> POST /sessions（注册会话）"
curl -sS -w "\nHTTP %{http_code}\n" "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d "{
    \"session_id\": \"${SESSION_ID}\",
    \"user_selected_mode\": \"Lite\",
    \"capture_mode\": \"Lite\",
    \"start_time\": \"2026-04-02T10:00:00Z\",
    \"device_model\": \"MockDevice\",
    \"ios_version\": \"18.0\",
    \"app_version\": \"1.0.0-mock\",
    \"upload_status\": \"not_uploaded\"
  }" \
  "$BASE/sessions"
echo
echo

echo "==> POST /upload_sensor（单条）"
curl -sS -w "\nHTTP %{http_code}\n" "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d "{
    \"session_id\": \"${SESSION_ID}\",
    \"sensor_type\": \"acc\",
    \"x\": 0.01,
    \"y\": -0.02,
    \"z\": 9.81,
    \"timestamp\": \"2026-04-02T10:00:01.000Z\"
  }" \
  "$BASE/upload_sensor"
echo
echo

echo "==> POST /upload_sensor_batch（批量 2 条）"
curl -sS -w "\nHTTP %{http_code}\n" "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d "{
    \"items\": [
      {
        \"session_id\": \"${SESSION_ID}\",
        \"sensor_type\": \"gyro\",
        \"x\": 0.001,
        \"y\": 0.002,
        \"z\": -0.003,
        \"timestamp\": \"2026-04-02T10:00:02.000Z\"
      },
      {
        \"session_id\": \"${SESSION_ID}\",
        \"sensor_type\": \"acc\",
        \"x\": 0.0,
        \"y\": 0.0,
        \"z\": 1.0,
        \"timestamp\": \"2026-04-02T10:00:03.000Z\"
      }
    ]
  }" \
  "$BASE/upload_sensor_batch"
echo
echo

echo "==> GET /sessions"
curl -sS "${AUTH[@]}" "$BASE/sessions" | python -m json.tool 2>/dev/null || curl -sS "${AUTH[@]}" "$BASE/sessions"
echo
echo

ENC_SESSION=$(python -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$SESSION_ID" 2>/dev/null || printf '%s' "$SESSION_ID")

echo "==> GET /sessions/.../samples?limit=10"
curl -sS "${AUTH[@]}" "$BASE/sessions/${ENC_SESSION}/samples?limit=10" | python -m json.tool 2>/dev/null || curl -sS "${AUTH[@]}" "$BASE/sessions/${ENC_SESSION}/samples?limit=10"
echo
echo

echo "==> PATCH /sessions/...（更新元数据）"
curl -sS -w "\nHTTP %{http_code}\n" "${AUTH[@]}" \
  -X PATCH \
  -H "Content-Type: application/json" \
  -d "{
    \"upload_status\": \"uploading\",
    \"total_imu_samples\": 3,
    \"duration_ms\": 5000
  }" \
  "$BASE/sessions/${ENC_SESSION}"
echo
echo

echo "==> DELETE /sessions/...（删除会话；若 DB 有 ON DELETE CASCADE 会顺带删 sensor_data）"
curl -sS -w "\nHTTP %{http_code}\n" "${AUTH[@]}" -X DELETE "$BASE/sessions/${ENC_SESSION}"
echo
echo

echo "==> 完成。若某步 503，请在 Supabase 执行 schema_extras.sql 创建 session_stats 视图。"
echo "==> 若某步 401，请 export API_SECRET 与 .env 中一致后再运行。"
