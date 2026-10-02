# SGX 分类全栈交付候选：验证报告

> 日期：2026-10-02
> 补充验证：2026-10-03
> 包状态：`integration_candidate`
> 源分支：`codex/classification-contract-v1`
> 基础提交：`1e162e0`，交付包同时包含当前尚未提交的集成改动；`MANIFEST.sha256` 是本包实际内容的完整校验依据。

## 已通过

|检查|结果|证明范围|
|---|---|---|
|Schema/types 一致性|通过|生成类型与 JSON Schema 一致|
|分类、组织、生命周期和 Worker Node 测试|`456/456` 通过，`0` 失败，`0` 跳过|包含 execution-context、OCR evidence、embedding Top-K、撤权、迟到拒收、跨 scope、编译后的 Stage A 子进程、StoryUnit 和持久下载路径 fail-closed 校验|
|TypeScript typecheck|通过|当前仓库 TypeScript 静态检查|
|部署/回滚 fixture|通过|隔离目录、路径防逃逸、`VERIFIED`、原子激活与回滚|
|扩展密钥扫描|通过|contracts、算法、页面/BFF、Worker、Python 服务、交付文档和脚本未发现已知格式凭据|
|`git diff --check`|通过|无空白错误|
|Python `compileall`|通过|Feature Service 源码和测试文件可被当前 Python 解析|
|远端 Feature Service pytest|`28/28` 通过，`0` 失败|在 VirtAI Python 3.10 隔离 venv 中，从持久 wheelhouse 离线安装后执行；证明当前 Python adapter、契约和错误处理测试通过，不证明模型效果|

## Python 远端补充验证

本机默认 Python 3.14 没有安装 `pytest`、FastAPI 和 Pydantic，因此本机门禁仍不会隐式安装依赖。2026-10-03 已在 VirtAI 的 Python 3.10 隔离环境完成同一套 Feature Service 测试：`28/28` 通过。安装来源是持久盘中的离线 wheelhouse，测试日志保存在：

```text
/gemini/code/sgx-classification/shared/manifests/feature-service-pytest-20261002.log
```

基础测试 wheelhouse 位于：

```text
/gemini/code/sgx-classification/shared/wheelhouse/feature-service-test-py310-20261002
```

其 SHA-256 清单和摘要分别位于：

```text
/gemini/code/sgx-classification/shared/manifests/feature-service-test-py310-20261002.sha256
/gemini/code/sgx-classification/shared/manifests/feature-service-test-py310-20261002.summary.json
```

复现测试仍使用：

```bash
PYTHONPATH=services/classification-feature-service/src \
  python3 -m pytest -q services/classification-feature-service/tests
```

该 wheelhouse 只冻结了测试依赖获取结果。正式 release 仍需生成目标平台带 hash 的完整 transitive lock，并绑定 release manifest；不能把当前 `requirements*.in` 或本次测试 wheelhouse 单独当作生产锁文件。

## 真实模型证据边界

- Qwen3.7 Flash 已有历史真实 API 工程探针和真实页面入口，但本次打包没有新增付费调用。
- RapidOCR + PP-OCRv5 mobile 已有远端合成 OCR 工程基线和 artifact hash；不代表真实手机照片 OCR 准确率。
- 中文 embedding、YuNet/SFace 和 SenseVoiceSmall/FunASR 的最终 artifact/runtime/license/hash 尚未全部冻结。
- 本报告不能证明真实家庭照片准确率、用户收益、跨年龄人脸匹配或生产 SLA。

## 交付判断

该包可以交给全栈工程师开始产品控制面、对象存储、Job/lease、结果 CAS、智能相册 UI 和 Worker 联调。它不能作为生产发布包；开放内部用户前，仍必须补齐真实模型 artifact Gate、固定分母真实功能矩阵和真实产品端到端验收。
