# 后端接口说明（产品 / 测试）

面向 **Flask 网关 + Supabase** 的 HTTP API。完整字段与类型见项目根目录 **`openapi.json`**，运行时也可访问 **`GET /openapi.json`**（若服务端配置了 `API_SECRET`，需带鉴权头）。

**环境**：`SUPABASE_URL`、`SUPABASE_KEY`、`API_SECRET`（可选）见根目录 `.env.example`。业务上 iOS 只连你自己的网关，不把 Supabase **service_role** 放进 App。

**推荐调用顺序**：注册会话 → 上传数据 →（可选）更新元数据 / 上传状态 → 列表与拉取明细 → 删除会话。

### 时间字段约定（`start_time` / `end_time` / `timestamp` / `since`）

- **ISO8601 字符串**：始终支持（写入 Postgres `TIMESTAMPTZ`）。
- **JSON 数字**：视为 **Unix 墙钟时间**——秒；若数值 **> 1e12** 则按 **毫秒** 再折算为秒。须 **≥ 1e9** 量级（约 2001 年之后），否则会被拒绝。  
  **说明**：`CACurrentMediaTime` 是「开机后秒数」，**不是** Unix 纪元；若直接当数字上传会报错。请二选一：  
  - 客户端用 `Date().timeIntervalSince1970`（或等价）发 **Unix 秒**；或  
  - 仍用 **相对录制起点** 的秒数，并在 **`POST /upload_sensor`** 或 **`POST /upload_sensor_batch`** 上设 **`timestamp_is_elapsed: true`**（此时每条 `timestamp` 为 **数字**，表示相对 **`sessions.start_time` 墙钟时刻** 的秒数；录制起点墙钟应与创建会话时的 `start_time` 一致）。
- **`GET .../samples?since=`**：可为 ISO 字符串，或 **Unix 秒/毫秒** 数字字符串，服务端会归一成与库内比较一致的格式。

### 批量上传路由

本仓库 **Flask 已实现** **`POST /upload_sensor_batch`**。若线上只看到 404，说明部署的进程/网关 **不是** 当前代码版本，需同步部署；客户端 **`APIConfig.baseURL`**（或等价配置）须指向该网关。

### iOS（SwiftPM `IOSBehindAPI`）

- 修改 **`APIConfig.baseURL`**：模拟器/真机访问电脑上的 Flask 时改为 `http://<电脑局域网IP>:5000`；上线改为 HTTPS 网关。
- 默认 **`IOSBehindClient()`** 便捷初始化使用 **`APIConfig.baseURL`**。

---

## GET /health

- **作用**：健康检查，判断服务进程是否存活。
- **特点**：不访问数据库；若未启用 `API_SECRET`，无需鉴权。

---

## POST /sessions

- **作用**：注册一次采集会话，在表 **`sessions`** 插入一行元数据。
- **必填 JSON**（示例字段）：`session_id`（业务 UUID，与后续上传一致）、`user_selected_mode`、`capture_mode`、`start_time`。
- **可选**：`device_model`、`ios_version`、`app_version`、`end_time`、`duration_ms`、各 `total_*`、`upload_status` 等。`start_time` / `end_time` 支持 **ISO8601** 或 **Unix 秒/毫秒**（见上节）。
- **返回**：`session` 中含数据库自增 **`id`**（内部用）与 **`session_id`**（业务主键，全链路使用）。

---

## POST /upload_sensor

- **作用**：写入 **单条** 采样到 **`sensor_data`**。
- **要求**：`session_id` 必须已通过 **`POST /sessions`** 注册。
- **`timestamp`**：ISO8601 或 Unix 数字；可选 **`timestamp_is_elapsed: true`**（见上节）。
- **返回**：新行的 **`sensor_data.id`**（表内全局自增，与 `sessions.id` 无对应关系）。

---

## POST /upload_sensor_batch

- **作用**：**批量**写入多条采样，减轻 HTTP 压力（**本网关已实现**）。
- **要求**：同一请求内所有 `items` 的 **`session_id` 必须相同**；且该会话已注册。
- **可选顶层字段** **`timestamp_is_elapsed`**：为 `true` 时，本批每条 `items[].timestamp` 默认为相对 **`sessions.start_time`** 的秒数；某条若自带 **`timestamp_is_elapsed`**，则以该条为准。
- **返回**：`count`、`ids`（本批插入的多条主键）。

---

## GET /sessions

- **作用**：会话 **列表 + 汇总**（依赖视图 **`session_stats`**：`sessions` 全列 + `sample_count`、`first_timestamp`、`last_timestamp`）。
- **用途**：列表页、统计；**不包含**每条原始采样点。
- **注意**：若返回 503，需在 Supabase 执行项目内 **`schema_extras.sql`** 创建/更新视图。

---

## GET /sessions/{session_id}/samples

- **作用**：按 **`session_id`（TEXT）** 分页拉取 **`sensor_data`** 明细（图表、回放、导出）。
- **查询参数**：`limit`、`after_id`（上一页 `next_cursor`）、可选 `since`。
- **要求**：该 `session_id` 在 **`sessions`** 中已存在。

---

## PATCH /sessions/{session_id}

- **作用**：按 **`session_id`** **部分更新** `sessions` 一行（不删采样数据）。
- **典型用途**：写入 `end_time`、`duration_ms`、各 `total_*`；更新 **`upload_status`**（如 `not_uploaded` → `uploading` → `uploaded` / `failed`）。

---

## DELETE /sessions/{session_id}

- **作用**：按 **`session_id`** 删除 **`sessions`** 中对应行。
- **数据**：若数据库已配置 **`sensor_data.session_id` 引用 `sessions(session_id)` 且 `ON DELETE CASCADE`**，会一并删除该会话下所有采样；否则可能残留孤儿行，需在库侧约束。

---

## 鉴权（可选）

当 `.env` 中 **`API_SECRET` 非空** 时，除 **`GET /health`** 外，请求需携带其一：

- `Authorization: Bearer <API_SECRET>`
- 或 `X-API-Key: <API_SECRET>`

---

## 本地假数据联调

Windows PowerShell：`.\scripts\mock_api_curl.ps1`（需先 `python app.py`；若启用 `API_SECRET`，先设置 `$env:API_SECRET`）。

Git Bash / WSL：`./scripts/mock_api_curl.sh`。
