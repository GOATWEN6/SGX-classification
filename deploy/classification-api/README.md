# SGX 独立算法 API 部署

先读 [全栈接入说明](../../docs/algorithms/CLASSIFICATION_DIRECT_API_INTEGRATION_2026-10-09.md)。
源码 `deploy/classification-api`，云端 `current/classification-api`。
复用 `classification-worker/runtime` 内部算法执行，不需要外部 Worker 控制面。

## 发布目录

```text
/gemini/code/sgx-classification/
  current -> releases/<sha>
  previous -> releases/<old-sha>
  releases/<sha>/
    VERIFIED
    compiled/                  # 已冻结算法 TS 的 CommonJS 构建
    classification-worker/     # 原有 runtime/tools（与旧 worker 别名相容）
    classification-api/        # 本轮独立服务和管理程序
    feature-service/src/       # 已冻结模型组件代码
    node_modules/              # 已有依赖，无新增生产依赖
  shared/
    api-v1/                    # 新服务任务、素材、结果、历史候选、ASR
    api-budget/                # 权威预算账本，迁移时保留累计用量
    secrets/direct-api-token   # 0600；只通过私密渠道给产品后端
    secrets/qwen-api-key       # 0600；不交给浏览器或全栈素材包
    config/nonsecret.env       # 既有模型配置
    config/direct-warm-fixtures.json
    logs/                      # 分次启动保存日志，不覆盖旧失败
```

持久配置和模型留在 `/gemini/code`，虚拟环境、PID/锁在 `/quota`，单次推理临时文件在
`/tmp/sgx-classification/jobs/direct-api`。所有下载、权重和缓存仍使用既有持久路径。
旧 release 和旧 Worker 日志不覆盖。

## 启停与检查

```bash
bash /gemini/code/sgx-classification/current/classification-api/bin/start.sh <完整源码SHA>
curl http://127.0.0.1:8765/healthz
```

`version/readyz` 使用算法服务 Token；禁止复制 secret 到命令日志或工单。
组件 `8766/readyz` 可在同机诊断。不要再运行旧 Worker start-stack。

Qwen 凭据在 Mac 通过 `scripts/classification-keychain.zsh setup` 安全保存；
随后运行 `scripts/classification-direct-keychain-deploy.py --destination <已核验SSH目标>
--identity <专用SSH私钥路径> --port 30022` 加密传输至云端专用 `0600` secret 文件。
该脚本不输出密钥、不发模型请求。API 子进程独立读取该文件，模型组件和预热程序不继承
Qwen 凭据；配置完成后核验 API PID 再重启该子进程即可，不必重新加载模型。
停止服务前检查 `direct-supervisor.pid` 对应命令确为本服务，再发 SIGTERM；等待服务优雅
停止。启动脚本和管理程序均检查 active release、单实例锁和模型路径。
进行回滚时先停止管理程序，再使用旧部署 `activate-release.sh <旧sha>`；旧 82cab23 仅
有模型组件/Worker，**回滚它不意味着保留新的完整 API**。

ASR/分类同进程内部执行保护和预算，模型服务独立 Python 程序。管理程序 5 秒检测
子进程退出，至少 15 秒间隔重新启动；故障会记录退出码，冷启动期间拒绝新分类任务，
防止在模型未加载时耗费 Qwen。该机制不依赖 Notebook Cell、systemd 或开发机 SSH。

## 独立验证

```bash
CLASSIFICATION_BUILD_DIR=<classification TS 构建目录> \
NODE_PATH=<仓库node_modules> \
node --test deploy/classification-api/tests/direct-api.test.mjs
```

新测试验证鉴权、scope/actor、幂等、ASR artifact/结果和重启持久化，使用离线 fixture。
真实模型验证与进程恢复证据另记当日执行日志，不能用 fixture 证明实际准确率或 SLA。

长期上线需由全栈完成公网 HTTPS 和产品权限、由平台配置常驻实例。仅恢复子进程不足以
解决整实例被平台回收；本轮不修改全局 preload 或绕过平台计费/回收规则。
