# Fake HTTP 首链本地验收记录

日期：2026-09-14。分支 `codex/classification-contract-v1`；HEAD `d33a5c5`，本轮工作未提交。证据类型：synthetic_contract_only。范围：既有 7 个 HTTP/schema/测试/启动/说明变动文件及必要的 HTTP 夹具和两份交付说明。不涉及真实分类核心、生产 Prompt、全栈代码、新依赖或外部模型。

状态更新：上述 Fake HTTP 实现随后与 Stage A 核心一起进入本地提交 `505c274`；该历史验收的证据层级仍为 `synthetic_contract_only`，没有因此升级为真实算法或产品验收。

## 实际验证

| 实际命令 | 结果 | 证据范围 |
|---|---|---|
| `npm run test:classification`（修复前，默认沙箱） | 26/29；3 项 localhost EPERM | 环境阻塞，不能说明 HTTP 行为失败/通过 |
| `npm run test:classification`（允许 localhost，修复前） | 28/29；1 项失败 | 明确复现 `409 !== 200`，http.test.mjs 原第 55 行 |
| `npm run test:classification`（首次扩展后） | 47/49；2 项失败 | 测试夹具浅引用导致服务端版本/来源变更污染请求；保留失败并修正夹具复制边界 |
| `npm run test:classification`（独立请求快照修正后） | 49/49 | 既有 26 + 当时新增 23 项 |
| `npm run test:classification`（最终，含 CLI 信号退出） | **50/50，0 fail，0 skipped** | 既有 26 + HTTP/生命周期 24 项；Node 测试时长约 2.97 秒，不含前置编译 |
| `npm run typecheck` | 退出码 0 | 仓库 TypeScript 类型检查；MJS 行为由上述 Node 测试验证 |
| `npm run test:classification:secret` | 退出码 0；`voice secret scan ok` | 现有扫描器覆盖 contracts、harness、分类源码和 3 个 classification 脚本，包含新增启动脚本 |
| `npm run classification:fake-http -- --smoke` | 退出码 0 | 实际启动、healthz、合成 POST、停止、关闭端口、删除临时目录 |
| `git diff --check` | 退出码 0 | 差异空白检查 |

完整本地日志分别为 `/private/tmp/sgx-http-before.log`、`sgx-http-before-local.log`、`sgx-http-after.log`、`sgx-http-final-tests.log`、`sgx-http-acceptance-tests.log`、`sgx-http-typecheck.log`、`sgx-http-secret.log`、`sgx-http-smoke.log`。临时日志可能被系统清理，本文件保留阶段结果与固定分母。首次 smoke 出现 Ajv 根 `$ref` 旁关键字提示，随后改为等价 `allOf` 引用；最终 50 项已覆盖该 Schema 和两次真实 CLI 启动，未再出现该提示。

## 本次修复及证明

- 原测试将 partial 与 failed 用同 key、不同 runId/scenario 顺序执行，却期待两者都成功。现改为各场景使用独立服务任务；同 key 变更 requestId/runId/scenario 仍应 409，没有放宽冲突检查。
- 实际接入外层 Ajv 请求及响应校验，拒绝多余字段、错误类型/格式；请求还必须通过内层哈希校验。错误只返回稳定代码。
- 在异步执行前登记同 key Promise；实际并发 10 请求验证仅调用一次 Provider，运行中不同 payload 仍 409。
- 服务端预置合成授权/证据快照，在调用、完成和缓存重放时重验。7 类状态变化分别覆盖缓存与运行中拒收：授权撤回、授权版本、模型版本、证据版本、删除中、consent 移除、run 取消。
- 双家庭、同家庭不同主体、未知 scope、外来 sourceRef 均有实际 HTTP 测试；这里只证明预置合成状态下的隔离，不是生产 ACL 验收。
- 覆盖 success、needs_review、conflicted、partial_failure、failed、invalid_output、timeout、全维度拒判及 cancelled 响应。
- 覆盖截止后的缓存拒收；不合作 Provider 晚到不能替换 TIMEOUT；超出进程容量返回 429。
- 限制请求体字节数，拒绝错误 Content-Type / 非法 JSON；设置请求及头部超时，响应 no-store。
- 启动器链接已安装依赖到临时编译目录。实际 CLI 子进程分别接收 SIGINT 和 SIGTERM，均退出 0、关闭端口、清理目录；非正常强制杀进程/SIGKILL 的清理不在此保证内。

## 修改文件

| 文件 | 用途 |
|---|---|
| `contracts/classification-http.schema.json` | HTTP 草案及严格输入/输出/错误定义 |
| `harness/classification/fake-http-server.mjs` | 合成服务、请求校验、幂等、状态及迟到保护 |
| `harness/classification/http.test.mjs` | 24 项 HTTP/进程生命周期回归 |
| `harness/classification/schema.test.mjs` | 独立 Schema 入口数从 10 改为 11 |
| `harness/classification/fixtures/http/synthetic.mjs` | 服务端合成状态与独立请求快照构造 |
| `scripts/classification-fake-http.mjs` | 启动、示例输出、smoke、退出清理 |
| `package.json` | Fake 启动命令与扩充现有扫描范围，无新增依赖 |
| `harness/classification/README.md` | 入口与运行边界 |
| `harness/classification/HTTP_HANDOFF.md` | 运行、映射、错误、人工联调、待双方确认事项及 C036/C027 来源边界 |
| `harness/classification/HTTP_VERIFICATION.md` | 本记录 |

## 未完成与交接

外层响应仍是原草稿结构；resultStatus/workflowStatus 当前仅映射，未宣称独立语义维度已冻结。新 attempt、新追踪 ID、授权刷新后的重试、真实业务响应格式及总预算需双方确认。默认 1 秒执行上限、128 条任务容量都是 Fake 护栏，不是产品承诺。

未调用真实模型、未接入生产鉴权/对象读取、未持久化业务数据或 Memory、未进行产品联合验收。C036/C027 仅按本窗口接续材料记录为历史效果缺口，本次没有真实效果通过结论。

algorithm_ready=false；integration_ready=false；pilot_ready=false；production_ready=false。

停止 Fake 会清空本进程合成任务与临时编译目录；没有业务数据需要回滚。工作树修改全部保留，未 git commit/push/PR/merge。最终范围检查：已跟踪的真实分类源码无差异，未修改 `ai-frame-main/` 和 `银发AI相框-PRD:MVP.md`。
