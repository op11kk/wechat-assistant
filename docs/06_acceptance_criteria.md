# 验收标准与里程碑

## 验收标准

### 模式选择
- 支持 Full 的设备，用户可手动选择 Lite 或 Full
- 不支持 Full 的设备，Full 必须锁定且有原因说明
- 用户选 Full 后，系统不能静默改成 Lite
- 用户选择必须记录到 metadata

### Full 模式
- 输出 RGB + Depth + IMU + Pose
- 每个 RGB frame 都有时间戳 + pose
- depth 可通过 mapping 或 timestamp 对齐
- 单次至少稳定录制 10 分钟
- session 可保存、可上传、可解析

### Lite 模式
- 输出 RGB + IMU + Pose
- 无 LiDAR 时流程不失败
- 单次至少稳定录制 10 分钟
- session 可保存、可上传、可解析

### 稳定性专项
- 10 分钟不崩溃
- 20 分钟不出现明显变速
- 30 分钟不自动丢 session
- 中断场景保留 partial session 和日志

## 研发里程碑

| 阶段 | 内容 |
|------|------|
| M0 | 技术预研：镜头、depth、tracking、长录制 |
| M1 | Lite 模式闭环：录制、本地保存、上传 |
| M2 | Full 模式闭环：depth、pose、mapping |
| M3 | 稳定性专项：发热、漂移、finalize、恢复 |
| M4 | 正式支持矩阵和 QA 完整回归 |

## 异常与降级策略（示例）
| 场景 | 处理 |
|------|------|
| 相机权限缺失 | 禁止录制并提示 |
| Full 初始化失败 | 停止进入录制，提示切换 Lite |
| tracking 不稳定 | 允许继续录制，但显式标记 |
| 热状态 critical | 安全停止或禁止开始 |
| 存储不足 | 阻止开始或强制 finalize |
| APP 切后台 / 来电 | 安全终止并记录原因 |