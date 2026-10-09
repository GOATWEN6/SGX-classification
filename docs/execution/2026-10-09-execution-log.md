# 2026-10-09 SGX 独立算法 API 执行记录

## 用户决策与执行范围

用户确认全栈直接调用算法 HTTPS API：算法侧提供云端 `8765` 完整入口，全栈负责
HTTPS 映射、产品存储和界面；取消对外 Worker pull 接入要求。
执行依据：[本轮计划](../algorithms/CLASSIFICATION_DIRECT_API_PLAN_2026-10-09.md)。

## 当前事实

- 本轮从干净的 `a3780e5` 继续；不重放历史测试、不覆盖旧失败和 release。
- 云端旧 Feature PID25957 已退出，8765 不可达；日志最后提示
  `ORION_TASK_IDLE_TIME`，3600 秒无操作后退出。此证据不能推出本次 OOM。
- 旧 Worker 保持停止；原 `3139` 开发控制面不作为新服务依赖。
- 系统 PID1 不是 systemd；持久盘 `/gemini/code` 是文件存储。
- 云端 nonsecret.env 指向的 `authorizations/current.json` 不存在，真实付费前需从
  既有控制面找到权威授权和账本，不得从历史数字重置额度。

## 实现与验证

- 新增 `deploy/classification-api`，复用既有 TS 核心及 Stage A、ASR runtime，内部方法
  调用控制面；外部仅提供 Bearer + trusted caller 的任务/结果路由。
- 新增 OpenAPI 与中文详细接入流程，README 和旧交接入口标记方案已更新。
- 3 组聚焦 HTTP 测试通过，覆盖 scope/actor、幂等重发/冲突、人物授权、取消、ASR
  内部 artifact 路径、结果持久化和重启复读；离线 fixture 不计真实模型证据。
- 分类 TS 构建通过，新增 shell/Python/JS 语法、diff 与 secret scan 通过。
- 本机 `classification-lab-data.local` 找到权威 authorization/ledger：validation4，
  193 次/¥23.243669，4 条 settled entries；到期 `2026-10-10T00:00:00+08:00`。
  云端迁移应完整保留该账本，不能从 openingUsage=180 另建空账本。
- 本机 Keychain status（沙箱与提权均检查）为 missing，云端亦无 Qwen secret 文件。
  已请求用户本机安全配置；不索要聊天明文，不为满足 ready 写占位凭据。
- 空闲退出诊断：Python hooks、目标包与平台共享库未找到提示来源；现有日志支持
  一小时空闲退出，注入库不是已证实根因。新增独立进程管理/恢复与预热；不修改平台
  preload，长期实例常驻和超过一小时持续性仍需独立验证。

部署与真实 ASR 验证执行中；结果在同文件续记。
