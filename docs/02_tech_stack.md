# 技术方案与选型理由

## V1 推荐技术栈
- **相机/录制控制**：AVFoundation
- **world tracking / pose / depth**：ARKit
- **accelerometer / gyroscope**：CoreMotion
- **同步、写盘、恢复、上传**：iOS 原生模块
- **UI / 页面**：iOS 原生 UI
- **后端**：Supabase

## 技术原则
1. 这不是相机 APP，而是原生多模态采集系统。
2. 训练主数据不是 preview.mp4，而是结构化 session。
3. 不承诺天然完美同步，承诺统一时间基准 + 明确映射关系 + 可重建对齐。

## 补丁讨论结论（针对早期问题）
| 问题 | 结论 |
|------|------|
| 视频实时上传还是本地保存？ | **本地优先**，录制完成后上传。避免网络波动影响采集稳定性，支持分片录制（chunk）。 |
| 后端用 Swift / Python / Node.js？ | **推荐 Python (FastAPI)**。开发快、生态丰富、适合数据处理。性能瓶颈可后续用 Swift 重写关键模块。 |
| 时间戳标准？ | 统一使用 **`CACurrentMediaTime()`**（单调递增，纳秒级精度），作为所有传感器数据的主时钟。 |
| Odometry（位姿解算）？ | **直接使用 ARKit 的 camera pose**（VIO 融合）。CoreMotion 纯惯性方案精度不足，且无位置信息。 |