# 时间同步、本地存储与上传

## 时间同步与对齐

### 同步原则
- 所有数据流使用统一高精度时间基准
- RGB 是主 anchor 流
- Pose 绑定 RGB frame
- Depth 通过 mapping 或 timestamp 映射到 RGB
- IMU 独立高频流，通过统一时间戳关联

### 对齐要求
| 数据组合 | 对齐要求 |
|----------|----------|
| RGB + Pose | 必须帧级关联 |
| RGB + Depth | 必须可通过映射重建 |
| RGB + IMU | 必须可按时间戳对齐 |
| Full / Lite | 必须共享统一时间规范 |

### 工程要求
- 不允许各模态使用不同时间源
- 不允许录制结束后再靠猜测补齐关联关系
- metadata 中必须保留对齐与缺失信息

## 本地存储结构（建议）
/session_{session_id}/
manifest.json
camera.json
pose.csv
imu.csv
index/
rgb_frames.csv
depth_frames.csv
video/
chunk_0001.mp4
chunk_0002.mp4
depth/
chunk_0001.bin
chunk_0002.bin
logs/
session.log
preview.mp4

### manifest 最低字段
- session_id, schema_version, user_selected_mode, available_modes, full_mode_disable_reason
- capture_mode, has_lidar, has_depth, device_model, ios_version, app_version
- start_time / end_time, duration_ms
- total_rgb_frames, total_depth_frames, total_imu_samples, total_pose_samples
- known_issues, upload_status

## 上传与后台要求

### 上传原则
- 原生模块执行
- 支持 session / chunk 级上传
- 支持断点续传和失败重试
- 上传前必须做完整性校验

### 上传要求
| 项目 | 要求 |
|------|------|
| 上传方式 | chunk / session 级 |
| 上传前检查 | manifest、chunk、index 一致性 |
| 失败恢复 | 支持 |
| 上传状态 | not_uploaded / queued / uploading / uploaded / failed / partial_failed |

### 后台兼容
- Full：解析 RGB、Depth、IMU、Pose
- Lite：解析 RGB、IMU、Pose
- Partial：可入库，打质量标签
- Invalid：拒绝进入主训练流程