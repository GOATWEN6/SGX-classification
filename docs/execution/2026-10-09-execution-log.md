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

## 云端部署与真实组件证据

- 新 immutable release=`bcecd6889a67c7a7eb4311cb24c2b247b1a7d56a` 已部署，previous 保留
  `82cab23`。源包 SHA-256、预算包 SHA-256、compiled import 均通过。
  原 TS 核心/模型 runtime 与 82cab23 无代码差异，复用构建和既有真实算法证据。
- 云端迁移完整 validation4 ledger，193 次/¥23.243669，4 条 settled entries，
  `shared/api-budget` 为新 API 权威账本；不重建余额、不延长到期时间。
- `8765/healthz=200`、`version=200 classification-direct-api.1`；内部 `8766/readyz=200`，
  OCR、image/text embedding、face、ASR 均 loaded。完整 API `readyz=503`，准确反映
  Qwen secret 缺失；componentsReady/asrReady=true，classificationReady=false。
- 通过 **8765 完整任务 API**提交既有冻结 WAV，SenseVoiceSmall 真实 ASR succeeded，
  全流程约 2.675 秒；幂等重发返回同 jobId，401/跨家庭403正确。原始音频和结果在
  持久 `shared/api-v1`。脱敏证据：`shared/manifests/direct-api-asr-live-20261009-r1.json`。
- 受控 SIGTERM API 后管理程序拉起新 PID，ASR result SHA-256 完全一致；受控停止组件
  后自动重启并重新预热，约125秒全部 ready。证据：
  `shared/manifests/direct-api-recovery-20261009-r1.json`。这证明受控进程退出恢复，
  不证明平台实例回收解决或一小时以上稳定性。
- OpenAPI 使用云端已有 PyYAML 成功解析，10个路径；未安装依赖。
- 本轮至此无新 Qwen 请求，无新模型下载。用户正在准备安全填写 Qwen Key。
- 追加准入/租约预留共用互斥，4/4 聚焦 HTTP 用例通过，覆盖并发时仅剩1次额度的
  两个提交只能接收一个，以及 receipt 中断时拒绝自动创建第二个任务。
- 本机旧 validation4 账本先备份 `ledger.before-cloud-direct-20261009.json`，再将
  local state 置 halted；迁移 receipt 独立保存。云端成为本轮唯一权威预算源，避免
  本机与云端各自复用同一剩余额度；不影响旧结果和已结算费用。
- API 子进程单独读取云端 Qwen secret，组件与预热不继承模型凭据。新增安全迁移脚本
  只走 Keychain→SSH stdin→专用0600 secret，日志不包含凭据，配置后仅重启API即可。

## 后续最小闭环

最终运行源码 release=`87631dadb8cf9ece27eec96fe742033a4d3c8cef`，previous=bcecd68。
新release保留原ASR、权威预算和所有旧失败。激活时旧管理程序的 PID 残留被启动保护
误判；核验 Z/gone 后归档 PID 并启动成功。源码 start.sh 追加进程状态判断，僵尸
视为已退出；该启动工具独立更新，不修改运行中的冻结release或模型代码。

安全注入 Key 后新增入口一条真实图文任务与必要跨轮复读，校验分类/归纳、授权后人物
候选、结果和历史候选，不重跑旧矩阵。GitHub交付文档和代码；公网HTTPS映射及产品
入库/页面由全栈完成。10人长期内部测试的真实调用预算与平台常驻不是本轮已验证事实。
