# 2026-10-08 SGX 分类归纳执行记录

## 本轮目标与授权

优先解决全栈反馈“CL 没有算法服务，只剩持续报错 Worker”，核验真实服务并恢复，
给出准确端口/调用边界，随后再进入实际产品测试。沿用原目录隔离、冻结发布、
人物候选和预算授权；不改模型选型，不重复旧算法测试，不读取或输出密钥内容。

## 实测根因与恢复

- SSH 使用既有用户指定平台地址及既有 RSA identity；未改全局 SSH 配置。
- 云端 current=`82cab23cd81a2f0b06a3c00606025153a2816468`，previous=`09b5f04b0c19a1a528b079da19c20072f201cdb1`。
- Feature PID 24349 已失效，8765 无监听；日志出现 `ORION_TASK_IDLE_TIME`。
- Worker PID 24365 持续 classification/ASR `lease_poll_failed / INTERNAL_ERROR`，
  日志约 12 MB。控制面为 `http://127.0.0.1:3139`，TCP 可连但 HTTP
  `RemoteDisconnected`；是失效开发隧道，不是产品后端。
- 文档启动路径不存在：云端真实目录 `current/worker`，旧文档误用
  `current/deploy/classification-worker`。
- 已向经身份核验的 Worker 发 SIGTERM，确认停止，两类 worker_stopped 日志保留；
  PID 归档。未删除 Job、未重试旧 pending。
- 旧 Feature 日志先备份后启动；既有离线环境和冻结模型复用。
  恢复进程 PID 25957；OCR、image/text embedding、face、ASR 已预热成功，
  `/readyz=200 ready`、`/version.gitCommit=82cab23`、Face/ASR enabled=true。
- 新预热记录独立写入持久 `shared/manifests/service-recovery-warm-20261008T*.json`；
  无 Qwen 请求、无模型下载或安装。该证据仅支持组件恢复，不是产品质量/SLA。

## 修复与交付

新增 `start-stack.sh`、`status-stack.sh` 和 `status-stack.py`；统一版本与 readiness
检查、默认不启动 Worker、拒绝占位地址/不可达 lease 路由，诊断只输出脱敏状态。
新工具不写回冻结算法 release，独立部署在持久 `shared/tools/service-operator-20261008-r1`。

更新 [服务恢复说明](../algorithms/CLASSIFICATION_SERVICE_RECOVERY_2026-10-08.md)、
部署 README 与全栈接手说明，区分源码/云端路径、冷启动预热、组件端口和任务入口。

用户询问后端是谁部署：已明确产品 staging HTTPS 后端由全栈部署，云端模型与
Worker 配置由算法侧负责；Owner 不需要自行实现后端。尚未收到正式 staging 地址。

## 验证与待决条件

- 启动行为聚焦 fixture 回归已通过，包括默认只启动 Feature、占位地址/缺 Token 拒绝、
  冷启动未 ready、版本不匹配、lease 路由 404 不启动 Worker、配置不执行及 secret/log 脱敏。
- Python 源码及 shell 语法检查通过。仅新增 shell/Python 操作工具与文档，未改 TypeScript，
  不重复整个 typecheck/模型矩阵。
- 远端工具已部署到 `shared/tools/service-operator-20261008-r1`，7 个脚本/工具的
  SHA-256 逐项通过；工具源码提交 `4475f545634fc05b077606aa6aa4c00a6e3a289d`。
  `start-stack.sh --release 82cab23…` 实测退出 0，healthz/version/readyz 通过，默认未启动 Worker。
- 只读 `status-stack.sh` 现场实测返回模型进程 running、全部组件 loaded、当前/上一版本
  VERIFIED、`control_plane_unreachable`、`worker_not_running`；非零退出码准确反映尚缺后端。
  脱敏证据保存为
  `/gemini/code/sgx-classification/shared/manifests/service-recovery-status-20261008T140139Z.json`。
  操作员环境 secret=false 只是当前 SSH 环境没有注入，不表示历史 secret 不存在。
- 聚焦部署 fixture、shell/Python 语法、受影响文档链接、secret scan 和 diff 检查通过。
  GitHub 上传以普通 fast-forward 指向既有交付分支，不改 main，不覆盖他人提交。
- 尚无稳定公网完整算法入口；全栈需 staging HTTPS、任务协议及服务鉴权，平台需常驻运行。
  不能把 SSH 30022 或 8765 当成产品调用接口。
- 本轮无新付费请求；既有结算 193/200、¥23.243669/¥50 作为后续检索线索，付费前核对账本。

## 转交全栈的材料

按用户要求新增 [可直接转交的接入说明](../algorithms/CLASSIFICATION_FULLSTACK_FORWARD_BRIEF_2026-10-08.md)，
集中列出恢复证据、准确端口、双方职责、必要文档/代码、首条产品任务验收与工程师回复模板。
README 增加入口，避免工程师从旧历史文档寻找不存在的启动目录。
本轮仅整理交付文档，采用链接/差异/secret 核验；未重跑模型或启动回归。
