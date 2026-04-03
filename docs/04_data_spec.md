# 数据采集规范

## RGB
- 帧率：目标 30fps
- 角色：主 anchor 流
- 必要字段：`frame_id`, `timestamp`

## Depth（仅 Full 模式）
- 来源：ARKit sceneDepth / smoothedSceneDepth
- 对齐策略：通过 timestamp / mapping 对齐到 RGB
- 不承诺每个 RGB 都有严格 1:1 depth

## IMU
- 内容：加速度计 + 陀螺仪
- 频率：目标 100Hz
- 必要字段：`timestamp`, `accel_xyz`, `gyro_xyz`
- 备注：保留真实时间戳，不强制端侧插值

## Pose
- 来源：ARKit camera pose
- 输出形式：per-frame pose
- 必要字段：`frame_id`, `timestamp`, `tx, ty, tz`, `qx, qy, qz, qw`, `tracking_state`
- 备注：V1 输出 pose，不把 odometry 高频流写成承诺

## 设备支持策略
- 支持等级：Officially Supported / Best Effort / Unsupported
- 原则：不写“所有 iPhone 都支持”，以 capability check 与真机矩阵为准