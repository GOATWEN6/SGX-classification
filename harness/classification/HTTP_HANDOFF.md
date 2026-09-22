# 分类 Fake HTTP：运行、边界与验收

日期：2026-09-14。外层接口为联调草案；服务仅验证合成契约，不提供真实分类准确率。算法侧负责本服务、测试与运行说明，全栈负责业务授权、数据、产品和部署。首个场景已确认：上传照片及可选说明 → 返回可追溯候选 → 全栈展示、筛选与纠正。

## 运行与停止

在本仓库根目录、已有锁文件依赖和 Node 22 环境运行，无需配置任何模型凭据：

```sh
npm run classification:fake-http
```

默认仅监听 `127.0.0.1:8787`，输出 JSON 包含 `url`、`exampleRequestPath` 和 `exampleExpiresAt`。在示例过期前使用输出的实际文件路径：

```sh
curl http://127.0.0.1:8787/healthz
curl -H 'Content-Type: application/json' --data-binary @/实际输出路径/example-request.json http://127.0.0.1:8787/v1/classify
```

示例过期后，可在另一终端生成新的请求（首次任务已完成时，新 deadline 仍属于不同 payload；先重启 Fake 清空旧任务，或由集成方建立新的业务任务/幂等键）：

```sh
npm run --silent classification:fake-http -- --example > /private/tmp/sgx-fake-request.json
```

Ctrl-C 或 SIGTERM 会取消服务内运行任务、关闭连接和端口、删除本次临时编译目录。临时目录只链接已有 node_modules，不安装依赖。重启清空全部内存任务；此机制不是生产持久化重试。

| 配置 | 默认值 / 含义 |
|---|---|
| `CLASSIFICATION_FAKE_PORT` | `8787`；`0` 自动分配端口，以启动输出为准 |
| `CLASSIFICATION_FAKE_SCENARIO` | `success`；只选 Fake 场景，不选择真实模型 |
| 内部执行上限 | 默认 1000ms，与请求 deadline 取更早者；仅为 Fake 本地检查参数 |
| 请求体上限 | 2,000,000 字节；超出返回 413，停止保留新增内容 |
| 内存任务容量 | 默认 128 条（含完成/失败）；满后新 key 返回 429，已有 key 仍可重放 |

上述数字都是测试护栏，不是已确定的产品耗时、重试或费用预算。无真实 Provider 切换开关。凭据不得交给此 Fake 或写进请求。

## 契约映射

`contracts/classification-http.schema.json` 与内层总 Schema 必须一起加载。请求和响应 definitions 都有实际运行时校验；HTTP Schema 未纳入现有 TypeScript 生成器。

| HTTP 草案字段 | 含义与来源 |
|---|---|
| `purpose` | 固定 `classification`，不因此授权写 Memory |
| `scope` | subjectId / householdId，与内层请求相同，必须命中服务端预置合成状态 |
| `authorizationRevision` | 必须匹配当前服务端合成版本；不是客户端自授权限 |
| `deadlineAt` | 与内层一致；过期缓存不得返回 |
| `providerRequest.evidence[]` | 每条的 sourceRef / sourceHash / revision 与服务端证据快照核对；不读取图片 |
| `resultStatus` | 暂沿用内层 Provider status；不宣称已经实现语义独立的双层状态模型 |
| `workflowStatus` | 当前映射：两类 failed → failed，其余沿用状态；最终业务任务状态归全栈 |
| `partial` | 当前专指存在 facetErrors；abstain 单独列出，不把所有不完整情况混为一个布尔值 |
| `abstain` | 无法判断的维度；`no_assertion` 不等于失败 |
| `needsReview` / `failed` | 按内层状态派生；成功处理仍只产生 proposed/conflicted 候选 |

保持既有草稿的原始 JSON 响应结构，未擅自切换为其他产品 envelope。`scenario` 和客户端 `authorizationState: withdrawn` 是 Fake 专用测试开关；客户端 active 不能恢复服务端撤回的状态。生产应由可信后端提供和核验授权，双方还需评审签发/验证方式及撤回通知。

## 幂等、缓存和迟到保护

同 scope、同幂等键、完整等价 JSON 请求（对象字段顺序不计，数组顺序保留）复用一个 Promise；在异步调用前登记，因此 10 个并发请求只执行一次。请求追踪 ID、runId、scenario、deadline 等任一内容变化，仍按原草稿返回 409，不能通过修改测试来放宽冲突。

接收请求、执行结束和每个响应/缓存重放前重验服务端状态。测试通过进程内 `states` 注入改变授权版本、撤回、模型版本、Evidence 版本/生命周期、consent 和取消记录；无远程状态管理 endpoint。`acceptProviderResult` 对正常 Provider 输出进行最终检查。runner 本地超时/取消决策单独处理，不把截止后 Provider 输出当成可接收结果。未合作 Provider 在超时后的返回不能覆盖已返回超时结果。

预检查拒绝、容量限制返回 HTTP 错误；模型执行成功到达服务但业务结果失败时，HTTP 200 内可含 `failed_retryable/failed_terminal`。调用方必须检查结果状态。

| HTTP | 稳定错误码示例 |
|---|---|
| 400 | INVALID_ENVELOPE / INVALID_CONTRACT |
| 403 | NOT_AUTHORIZED / AUTHORIZATION_REVOKED / SCOPE_MISMATCH |
| 409 | IDEMPOTENCY_CONFLICT / AUTHORIZATION_CHANGED / VERSION_EXPIRED / STALE_RESULT / INACTIVE_EVIDENCE / SCOPE_OR_DEADLINE_MISMATCH |
| 413 / 415 | BODY_TOO_LARGE / UNSUPPORTED_MEDIA_TYPE |
| 429 | RATE_LIMITED：Fake 容量保护，无自动重试 |
| 500 | INTERNAL_ERROR：不回显底层异常文本 |

当前缓存与取消状态是单进程测试能力，没有身份认证、跨进程原子存储或生产 ACL。以后替换为真实服务时，需共同定义“新追踪 ID 的重放”“失败任务新 attempt”“授权刷新后重新处理”，并审查总超时/重试预算、外层状态含义及产品 envelope。没有因本次修复冻结这些重要选择。

## 验收命令与人工联调

```sh
npm run test:classification
npm run typecheck
npm run test:classification:secret
npm run classification:fake-http -- --smoke
```

受限环境可能禁止监听 localhost，报 EPERM 时需平台允许本地监听；不能把环境阻塞记成行为测试通过。实际结果见 [本轮验收记录](HTTP_VERIFICATION.md)。

全栈人工验证：启动 Fake → healthz → 示例 POST → 检查 proposed 及来源 → 原样重发确认 replay → 改相同 key 的 scenario 确认 409 → 重启并使用独立请求分别测试 conflicted/partial_failure/invalid_output/timeout → 停止服务并确认端口关闭。对撤回和版本变更先运行自动化案例；生产授权接入后再做双方联合验收。

## 真实效果缺口与来源

| 案例 | 历史问题 | 本次证据边界 |
|---|---|---|
| C036 | `quality=blurred` 漏标 | 来源：本任务用户提供的接续摘要及总控 9/14 委派；本轮未重新读取原图/模型结果，未做效果复测 |
| C027 | 纯照片证据不足以证明 screenshot | 同上；需要区分视觉证据与文件来源/上下文，不能靠 Fake 固定标签证明已解决 |

这两项仅为来源明确的历史效果缺口，未计入 HTTP 通过数量。正式 taxonomy、标签和指标待方案及用户决定；本轮不修改生产 Prompt 或真实分类核心。

算法结果不直接写业务数据库或长期 Memory。真实授权/对象读取、生产日志与临时素材保留规则、真实模型与产品联合验收均未完成。algorithm_ready / integration_ready / pilot_ready / production_ready 仍为 false。
