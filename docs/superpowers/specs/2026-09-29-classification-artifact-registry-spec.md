# SGX 自动分类实验产物登记规范（E0）

> 日期：2026-09-29
>
> 状态：冻结用于 E0 实现
> 适用范围：自动分类与归纳的合成数据冻结、真实模型探索、离线 replay、评分报告和阻断记录

## 1. 目标

下一次实验必须在运行前确定 Git 外的持久目录，并在结束后留下可独立校验的产物登记。登记用于回答四个问题：

1. 这次运行使用了哪一批数据、模型、Prompt、Guard、truth 和 scorer；
2. 哪些文件实际存在，它们的原始字节是否后来发生变化；
3. 使用了什么授权和预算边界，实际请求与费用是多少；
4. 这个结果属于合成数据功能证据、真实模型工程证据、真实用户数据证据、mock 还是离线 replay。

E0 不恢复已经消失的文件，不补造旧 raw response，也不计算模型准确率。

## 2. 最小设计

每个 run 在自己的持久 `outputRoot` 下保存实际产物和一份 `artifact-registry.json`。registry 只保存元数据、相对路径、字节数和 SHA-256，不复制或嵌入图片、音频、用户文字、模型 raw response 或 approval 正文。

```text
<persistent-private-root>/
└── <run-id>/
    ├── manifest.json
    ├── approval-reference.json
    ├── preflight.json
    ├── provider-responses.jsonl
    ├── result-*.json
    ├── ledger.json
    ├── metrics.json
    ├── REPORT.md
    └── artifact-registry.json
```

本轮采用“每个 run 一份严格 registry”的小实现。跨 run 的全局成本账本在后续 runner 接线时由多个已校验 registry 聚合，不先引入数据库、MLflow、DVC 或新的服务。原因是当前缺口是证据丢失和不可校验，而不是实验 UI 或远程 artifact 服务；仓库已有 SHA-256、固定分母、staging/rename 和 approval 绑定机制，复用它们能以最小改动解决当前阻断。没有复制任何第三方源码。

## 3. 持久目录边界

默认规则：

- `outputRoot` 必须是绝对路径；
- 禁止位于 `/tmp`、`/private/tmp`、`/var/tmp` 或当前系统临时目录；
- 正式运行必须放在 Git 工作树之外；
- 从 `outputRoot` 向文件系统根检查任一祖先的 `.git` 目录或 worktree `.git` 文件，不能只检查当前 SGX 仓库；
- 目录及 registry 使用 owner-only 权限；
- artifact 路径只能是 `outputRoot` 内的受控相对路径；
- 拒绝 `..`、反斜杠、换行、绝对 artifact 路径、符号链接、硬链接和非普通文件；
- 测试只能通过显式 test-only 选项使用临时目录，该选项不能成为真实 CLI 默认值。

Registry 不是访问授权。读文件的进程仍必须经过本地文件权限和产品授权边界。

## 4. Registry 字段

Schema 版本固定为 `sgx-artifact-registry.1`，字段封闭。核心结构如下：

|区域|用途|
|---|---|
|`registryId / revision / createdAt`|登记自身身份|
|`claimBoundary`|明确证据能支持的结论边界|
|`outputRoot`|私有本地绝对路径；不得复制到公开报告|
|`identity`|pipeline、dataset、batch/run、provider/model、Prompt/Guard、taxonomy、truth、scorer 版本|
|`authorization`|只保存 approval hash、opaque evidence ref、expiry、caps 与 `maxRetries=0`；允许整体为空|
|`sourceRegistryRefs[]`|跨 run 的父 registry ID、registry bytes hash 和被引用 artifact ID；用于 replay/rescore 的不可变来源锚点|
|`artifacts[]`|角色、相对路径、SHA-256、字节数、敏感级别和 provenance 引用|

允许的 evidence lane 至少区分：

- `synthetic_fixture`
- `real_model_on_synthetic`
- `real_user_authorized`
- `mock_transport`
- `offline_replay`
- `summary_only_missing`

任何报告必须使用与 registry 一致的 lane，不能把真实模型处理合成图片写成真实用户数据效果。

所有 lane 都必须填写 pipeline、dataset、run、truth 和 scorer 身份。`real_model_on_synthetic`、
`real_user_authorized` 和 `offline_replay` 还必须填写 provider、model、Prompt 与 Guard；前两个真实调用
lane 必须绑定非空 authorization。`offline_replay` 必须至少引用一个父 registry，不能把没有原始响应锚点的
手工 JSON 写成 replay。

每种 lane 还必须包含以下 artifact `kind`。`kind` 使用封闭枚举；新增证据角色要升级契约，不能用任意字符串绕过完整性检查。

|lane|必需 artifact kind|
|---|---|
|`synthetic_fixture`|`dataset_manifest`、`truth`、`scoring_policy`、`checksum_manifest`|
|`real_model_on_synthetic` / `real_user_authorized`|`dataset_manifest`、`truth`、`scoring_policy`、`preflight`、`approval_reference`、`provider_response`、`request_ledger`、`metrics`、`report`|
|`mock_transport`|`dataset_manifest`、`truth`、`scoring_policy`、`request_ledger`、`metrics`、`report`|
|`offline_replay`|`truth`、`scoring_policy`、`source_response_reference`、`replay_result`、`request_ledger`、`metrics`、`report`|
|`summary_only_missing`|`missing_evidence_ledger`、`report`|

如果真实执行在发送请求前停止，`provider_response` 可以是合法的零字节 JSONL，但 `request_ledger` 必须保留 0 请求、0 费用和停止原因；writer 对零字节文件计算真实 SHA-256，不填充伪造响应。这样既不把“计划文件齐全”误写成实验完成，也不会因为失败而丢弃证据。

## 5. Hash 与可重复验证

- 单文件 hash：对原始文件 bytes 计算 `sha256:<64 lowercase hex>`；
- registry hash：对写入磁盘的 registry 原始 bytes 计算；registry 不包含自己的 hash，避免自引用；
- 路径比较使用规范化 POSIX 相对路径；
- verifier 重新读取每个登记文件，校验 containment、普通文件、byte length 和 hash；
- 任一 artifact 增删、替换、改名或字节变化都使原 registry 不再通过；
- `expectedRegistryHash` 可作为外部不可变锚点；后续 acceptance 或执行计划引用该值。

JSON 解析后的等价内容不能替代 raw-byte hash。格式化、换行或字段顺序改变都视为新 artifact。

## 6. Provenance 与不可变规则

- `artifactId` 与 `relativePath` 在一份 registry 内必须唯一；
- `provenanceArtifactIds` 只能引用同一 registry 中已经登记的 artifact；
- 跨 run 来源使用 `sourceRegistryRefs`，每项保存父 `registryId + registryHash + artifactIds`；当前离线 verifier
  校验结构、自引用和重复引用，后续跨 run catalog 再按 hash 定位并校验父 registry；
- provenance 图不得有悬空引用或循环；
- 相同 registry ID 指向不同文件集合时视为冲突，不得覆盖；
- replay、rescore、修正 truth 或 Prompt 后必须创建新 registry ID，并通过 `sourceRegistryRefs` 引用父产物；
- 历史失败、blocked、partial 和 `not_run` 仍是证据，不能为了“完整”从登记中删除。

本阶段 finalizer/verifier 不修改 payload。Stage A runner 的自动 finalization、崩溃恢复和 append-only 事件账本作为紧随 E0 的接线任务完成；在接线前，任何真实调用的执行清单都必须显式包含“持久 outputRoot + finalize + verify”。

## 7. 敏感信息边界

Registry 永不包含：

- API key、token、Bearer/header、cookie、Keychain 内容或环境变量快照；
- approval 正文；
- 图片/audio 的 base64 或 data URL；
- 用户原文、ASR 正文、位置/EXIF 内容；
- provider raw response 或任意上游错误正文。

这些内容如果是必要证据，只能作为 `restricted` artifact 留在私有 `outputRoot`，registry 仅记录相对路径、hash 和字节数。公开 Markdown 报告只写稳定错误码、字段路径和聚合统计。

`provider_response` 在所有 lane 中必须标记为 `restricted`。`real_user_authorized` lane 除纯规则文件
`scoring_policy` 和无正文的 `checksum_manifest` 外，所有 artifact 至少标记为 `private`；raw response
仍必须是 `restricted`。writer 和 verifier 都执行该规则，不能靠调用方自报较低级别。

## 8. 旧临时产物处理

以下 2026-09-29 文档引用路径在本次盘点时不可访问：

- r5 合成冻结目录；
- 首个真实 run 目录；
- 剩余五例真实 run 目录；
- `.12` exact replay 目录。

它们只登记为 `summary_only_missing`：保留 last-known path、首次确认缺失时间、来源文档/提交、预期文件角色和 `do_not_reconstruct`。不得声称“已删除”，因为根因未知；不得从 Markdown 汇总反向生成 raw response、hash 或 usage ledger。以后若找回原文件，创建新的 recovered 记录并逐字节校验，原 missing 记录继续保留。机器可读记录见 [`CLASSIFICATION_LEGACY_ARTIFACT_AVAILABILITY_2026-09-29.json`](../../algorithms/evidence/CLASSIFICATION_LEGACY_ARTIFACT_AVAILABILITY_2026-09-29.json)。

## 9. Gate 0

进入 E1 前必须满足：

1. strict draft-07 Schema 可由仓库现有 Ajv 加载；
2. finalizer 能从受控相对路径生成文件 hash 与 registry；
3. verifier 能发现字节篡改、长度变化、路径逃逸、symlink/hardlink、重复 ID/路径、悬空/循环 provenance 和 registry hash 漂移；
4. secret canary 和用户正文 canary 不出现在 registry JSON；
5. CLI 默认拒绝临时根，且明确报告 `credentialsRead=false`、`externalCalls=0`；
6. 四个旧路径有机器可读 missing ledger，且不被计为可重放证据；
7. 当前仓库、外部 Git repo 和 worktree 三种目录都被拒绝；每种 lane 缺少任一必需 artifact role 都 hard fail；
8. raw response 或真实用户证据被降级标记时 hard fail；
9. 聚焦测试、分类回归、typecheck、secret scan 和 `git diff --check` 有记录。

Gate 0 通过只证明实验产物登记机制可用，不证明 Stage A 效果、真实页面闭环或生产存储已经完成。
