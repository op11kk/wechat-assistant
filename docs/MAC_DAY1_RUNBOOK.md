# Mac 到货前准备 + 第一天「Xcode 一键 Run：IMU + API 全链路」Runbook

本文假设：**Flask 网关**在 **Mac 或同一局域网内一台电脑**上跑在 **5000** 端口；**数据库**在 **Supabase**；iOS 用 **`swift/IOSBehindAPI.swift`**（SwiftPM）或拷贝进工程。

---

## 第一部分：这周你最该做的三件事（按顺序）

### 1. 用 Git 把工程备份好

**目标**：代码在远程有一份；本机丢了也能拉下来；**绝不提交密钥**。

#### 1.1 若项目还没初始化 Git

在 **Windows** 上（工程根目录 `iosbehind`）打开终端或 PowerShell：

```powershell
cd D:\code\iosbehind
git init
```

确认 **`.gitignore`** 已包含（你仓库里应有）：

- `.env`（含 `SUPABASE_*`、`API_SECRET`，绝不能进仓库）
- `venv/`、`__pycache__/`、`.idea/` 等

检查 **没有**把 `.env` 加进暂存区：

```powershell
git status
```

若误加了：

```powershell
git rm --cached .env
```

#### 1.2 首次提交

```powershell
git add .
git commit -m "chore: initial backup of iosbehind gateway and docs"
```

#### 1.3 推到远程（GitHub / Gitee / 公司 Git 任选其一）

在托管平台新建**空仓库**（不要勾选自动 README，避免冲突），然后：

```powershell
git remote add origin <你的仓库 HTTPS 或 SSH 地址>
git branch -M main
git push -u origin main
```

之后每周至少：

```powershell
git add .
git commit -m "feat: 描述本次改动"
git push
```

#### 1.4 Mac 上第一次拉代码

```bash
cd ~/Projects   # 或你喜欢的目录
git clone <同上仓库地址> iosbehind
cd iosbehind
```

复制环境文件（**只在本地**）：

```bash
cp .env.example .env
# 用编辑器填好 SUPABASE_URL、SUPABASE_KEY、API_SECRET（与 Windows 一致或按环境区分）
```

---

### 2. Apple ID + 想好 Bundle ID

**目标**：真机调试与后续上架都依赖 **Apple ID**；工程里 **Bundle ID 全局唯一** 且**以后尽量不改**。

#### 2.1 Apple ID

- 若没有：在苹果官网注册 **Apple ID**（建议开启**双重认证**）。
- **免费账号**：可在 Xcode 里登录，用**个人团队**把 App 装到自己手机，但有证书/有效期限制，一般足够学习联调。
- **付费 Apple Developer Program（99 USD/年）**：需要上架 TestFlight/App Store、企业分发、更省心证书时再开；**不是第一天必须**。

#### 2.2 Bundle ID 命名规范（建议）

格式：`com.<公司或个人域名反写>.<产品名>`

示例（请换成你自己的，避免与示例冲突）：

- `com.yourname.iosbehind`
- `com.yourcompany.sensorcapture`

**注意**：

- 全小写、无空格；段之间用 `.`。
- 一经用于上架或与能力（Capabilities）绑定，**改名成本高**，请提前想好。

#### 2.3 在 developer.apple.com 可做的事（有付费账号时）

- 登录 [Apple Developer](https://developer.apple.com/account)。
- **Identifiers → App IDs**：注册与 Xcode 里**完全一致**的 Bundle ID（可选，Xcode 有时可自动管理）。

#### 2.4 第一天在 Xcode 里要做的事（预告）

- **Signing & Capabilities**：Team 选你的 Apple ID 团队；**Bundle Identifier** 填你定好的 ID。
- 若真机报签名错误：Xcode → Settings → Accounts 添加 Apple ID，回到 Target → Signing 勾选 **Automatically manage signing**。

---

### 3. 网关、API 文档、脚本再确认一遍

**目标**：到 Mac 后不要卡在「后端连不上、文档对不上」。

#### 3.1 后端清单（在 **跑网关的机器**上）

| 检查项 | 做法 |
|--------|------|
| Python 依赖 | `pip install -r requirements.txt`（建议 venv） |
| `.env` | `SUPABASE_URL`、`SUPABASE_KEY` 必填；`API_SECRET` 若设置，客户端必须带头 |
| 启动 | `python app.py`，默认 `0.0.0.0:5000` |
| 健康检查 | 浏览器或 `curl http://127.0.0.1:5000/health` → `{"status":"ok"}` |
| 视图 | Supabase 已执行 **`schema_extras.sql`**（`session_stats`），否则 `GET /sessions` 可能 503 |

#### 3.2 文档与契约

| 文件 | 用途 |
|------|------|
| `docs/API_OVERVIEW.md` | 给人看的接口说明、时间字段、`upload_sensor_batch`、鉴权 |
| `openapi.json` | 机器可读契约；运行时可 `GET /openapi.json`（若开了 `API_SECRET` 需带密钥） |
| `swift/IOSBehindAPI.swift` | iOS 客户端模型与 `IOSBehindClient` |

#### 3.3 脚本自测（Windows 已跑通可跳过；Mac 上建议再跑）

```bash
# 终端 1
python app.py

# 终端 2（PowerShell 用仓库里 scripts；Mac 用 bash）
./scripts/mock_api_curl.sh
```

确认：`POST /sessions` → 上传 → `GET /sessions` → `samples` → `PATCH` → `DELETE` 全流程无 401/503（按你 `.env` 是否设 `API_SECRET` 调整）。

#### 3.4 时间字段（与 iOS 对齐）

- **墙钟**：`Date().timeIntervalSince1970` 作 **Unix 秒** 发给网关（或与 ISO8601 二选一），见 `API_OVERVIEW.md`。
- **`CACurrentMediaTime`**：不是 Unix；要么在客户端换算，要么用 **`timestamp_is_elapsed: true`** + 相对 `sessions.start_time` 的秒数。

---

## 第二部分：Mac 到货「第一天」唯一目标

**目标**：在 **Xcode** 里 **Run（⌘R）** 一次，**模拟器或真机**上 App 跑起来，**Core Motion（IMU）** 有数据，且能 **调用你本机/局域网 Flask**，完成 **注册 session → 上传至少一条传感器数据 →（可选）拉列表**。

下面按「从零新建最小工程」写；若你已有 Xcode 工程，只取 **SwiftPM / 源码集成、ATS、APIConfig、IMU、Signing** 相关步骤即可。

---

### 阶段 A：Mac 环境与仓库

1. 安装 **Xcode**（App Store，体积大，提前下载）。
2. 打开 **Xcode → Settings → Locations**，确认 **Command Line Tools** 已选当前 Xcode。
3. `git clone` 你的仓库（见上文），`cp .env.example .env` 并填写。
4. 在仓库根目录：

   ```bash
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   python app.py
   ```

5. 另开终端：`curl http://127.0.0.1:5000/health` 确认 OK。

---

### 阶段 B：新建 iOS App（最小可运行）

1. Xcode → **File → New → Project**。
2. 选 **iOS → App** → Next。
3. **Product Name**：例如 `SensorCapture`（随意）。
4. **Team**：选你的 Apple ID 团队。
5. **Organization Identifier**：例如 `com.yourname`（与 Bundle ID 规则一致）。
6. **Bundle Identifier**：会自动变成 `com.yourname.SensorCapture`，请改成你在**第二部分第 2 节**定好的完整 ID（在 Target → General 里可改）。
7. **Interface**：SwiftUI 或 Storyboard 均可（下文以 **SwiftUI** 描述）。
8. **Language**：Swift。
9. 存储位置：可与 `iosbehind` 仓库**同级**（例如 `~/Projects/SensorCapture`），不必塞进后端仓库（避免把 App 和 Flask 绑在一个 repo 里混乱）；也可 monorepo，按你喜好。

---

### 阶段 C：接入 `IOSBehindAPI`（Swift Package）

**方式 1：本地 Package（推荐第一天快速联调）**

1. Xcode 菜单 **File → Add Package Dependencies…**。
2. **Add Local…**，选择你 clone 下来的 **`iosbehind` 仓库根目录**（内含 `Package.swift` 的那一层）。
3. 添加依赖到 **App Target**。

**方式 2：把 `swift/IOSBehindAPI.swift` 拖进工程**

- 若 SPM 有问题，可直接将文件加入 Target，并确保 **Deployment Target ≥ iOS 15**（与 `Package.swift` 一致）。

---

### 阶段 D：网络与 ATS（否则 http 请求会失败）

模拟器访问 **Mac 本机 Flask**：

- `APIConfig.baseURL = URL(string: "http://127.0.0.1:5000")!` 通常可用。

**真机**访问 **同一 Wi-Fi 下 Mac 的 IP**：

1. Mac **系统设置 → 网络** 查看 **IP**（如 `192.168.1.10`）。
2. 在 App 里设置：

   ```swift
   APIConfig.baseURL = URL(string: "http://192.168.1.10:5000")!
   ```

3. **HTTP 非 HTTPS**：需在 App 的 **Info** 里配置 **App Transport Security**（否则 iOS 默认拦 http）。

   - 选中 Target → **Info** → 添加 **App Transport Security Settings**：
     - **Allow Arbitrary Loads** = **YES**（仅开发期；上架前改为 HTTPS 或按域名配置例外）。

   或使用 **Exception Domains** 只放行你的 IP（配置稍繁，第一天可先用 Arbitrary Loads）。

4. **本地网络（真机）**：若系统弹出「是否允许查找本地网络设备」，选**允许**；若仅用 IP 直连，一般仍可工作；若遇阻，再在 **Signing & Capabilities** 里加 **Access WiFi Information** / 关注 iOS 本地网络权限说明。

5. **Mac 防火墙**：若真机连不上，在 Mac **系统设置 → 网络 → 防火墙** 中允许 **Python** 或 **5000 端口**入站（或暂时关闭防火墙做验证）。

---

### 阶段 E：`API_SECRET` 与客户端

若 `.env` 里 **`API_SECRET` 非空**：

```swift
let client = IOSBehindClient(apiSecret: "与 .env 完全一致")
```

若为空：

```swift
let client = IOSBehindClient()
```

---

### 阶段 F：IMU（Core Motion）最小逻辑

1. 在 Target → **Signing & Capabilities** 中一般**不需要**为加速度计单独加 Capability（与 HealthKit 等不同）。
2. **`Info.plist`**：若仅使用运动数据且不访问需要用途说明的 API，通常**不必**加 `NSMotionUsageDescription`；若你混用其他需要文案的能力，再按 Xcode 提示补充。
3. 代码思路（伪流程，具体 API 见 Apple 文档）：

   - 创建 `CMMotionManager`。
   - 用 **`startDeviceMotionUpdates`** 或 **`startAccelerometerUpdates` + `startGyroUpdates`**（按你需要的融合程度）。
   - 在主线程或指定队列取 `userAcceleration`、`rotationRate` 等，映射到你后端的 **`sensor_type`**（如 `acc` / `gyro`）和 **`x,y,z`**。
   - **时间戳**：第一天建议直接用 **`Date().timeIntervalSince1970`** 作为 **Unix 秒**，用 `SensorSampleInput` 的 **`TimestampField.unixSeconds(...)`**，与 Flask **`normalize_absolute_timestamptz`** 对齐。

4. **频率**：`interval` 例如 `1.0/50.0`（50Hz），避免过高导致主线程卡顿；可先在后台队列聚合再批量上传。

---

### 阶段 G：全链路调用顺序（与后端一致）

在「开始采集」或「首次拿到 IMU」时：

1. **`POST /sessions`**  
   - `CreateSessionRequest(sessionId: UUID().uuidString, userSelectedMode: "Lite", captureMode: "Lite", startTimeUnixSeconds: Date().timeIntervalSince1970)`  
   - 或 ISO8601 版本便捷初始化。

2. **循环或定时器里上传**  
   - **单条**：`uploadSensor(SensorSampleInput(..., timestamp: .unixSeconds(...)))`  
   - **批量**（推荐）：缓冲 N 条后 `uploadSensorBatch(items:)`。

3. **（可选）调试**：`listSessions()`、`listSessionSamples(sessionId:)`。

4. **（可选）结束**：`patchSession` 更新 `upload_status`；`deleteSession` 测试清理。

---

### 阶段 H：第一天验收标准（自检表）

- [ ] Xcode **Run** 无编译错误。
- [ ] App 界面能看到 **IMU 数值在动**（或日志在刷）。
- [ ] **模拟器**：`127.0.0.1:5000` 请求成功；或 **真机**：`http://<Mac IP>:5000` 成功。
- [ ] Supabase **`sensor_data`** 表里能看到新行（Dashboard → Table Editor）。
- [ ] 若开启 **`API_SECRET`**，未带头应 401、带头应成功。

---

### 常见问题速查

| 现象 | 可能原因 |
|------|----------|
| `Could not connect to the server` | Flask 未启动、IP/端口错、防火墙、真机与 Mac 不在同一 Wi-Fi |
| ATS 错误 / `http` 被拦 | Info.plist 未放行 HTTP |
| 401 Unauthorized | 未带 `Authorization` / `X-API-Key`，或与 `.env` 不一致 |
| 404 on `upload_sensor_batch` | 线上网关未部署当前代码；或 `baseURL` 指错 |
| 503 on `GET /sessions` | 未执行 `schema_extras.sql` |
| 400 on `timestamp` | 数字太小被当成非法 Unix；改用 `timeIntervalSince1970` 或 `timestamp_is_elapsed` 模式 |

---

### 建议的「第一天」时间分配（参考）

| 时段 | 内容 |
|------|------|
| 0.5–1 h | Git 拉仓库、Python venv、跑 Flask、curl 健康检查 |
| 1–2 h | Xcode 工程、Signing、SPM 接 `IOSBehindAPI`、ATS |
| 1–2 h | Core Motion 读数上屏或打日志 |
| 1–2 h | 接 `createSession` + `uploadSensor`/`Batch`，Supabase 验数据 |

---

**文档位置**：本文件 `docs/MAC_DAY1_RUNBOOK.md`。若你后续固定用某一个 App 仓库，可把「阶段 B」改成你的真实工程名，并把 **Bundle ID、Team、网关 IP** 记在团队 Wiki 或私有笔记里（仍不要提交 `.env`）。
