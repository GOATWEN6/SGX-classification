# 图文分类 T0/T1 实施与全栈交付计划

> 状态：Active  
> 日期：2026-09-27  
> 产品依据：[混合召回、按需 VLM 与渐进自动化 Spec](../specs/2026-09-27-classification-hybrid-retrieval-adaptive-automation-spec.md)

## 1. 目标与责任边界

当前工作包完成：

- T0 离线算法验证；
- T1 本地产品 Alpha；
- 一套全栈工程师可以独立读取、启动 Fake、复现主链并替换适配器的交付包。

全栈在此基础上负责 T2 的生产数据库、对象存储、队列、鉴权、双端互传和正式智能相册页面。T3 使用另一套跨家庭独立数据；不得复用 T0/T1 素材或调参信息证明泛化。

本计划不调用付费 API，不读取密钥，不部署，不 push，不制作正式相册 UI。真实 Provider 运行仍需按具体模型、批次、费用和授权单独审批。

## 2. 依赖顺序

```text
P0 决策与契约冻结
→ T0-A 稀疏组织工程基线
→ T0-B 真实素材与 Source Gate
→ T0-C 离线固定分母评测
→ T1-A 本地实验台后端
→ T1-B 浏览器实验页
→ T1-C 验收与全栈交接
```

全栈可以在 P0 后提前评审契约；正式进入 T2 等待 T1-C。

## 3. 阶段、任务与 Gate

### P0：冻结输入、hybrid 与权威边界

- 冻结图片、独立文字、final ASR、单图/多图/批次绑定和 `album_upload / family_transfer`；
- 冻结 `AssetFeature`、`RetrievalCandidate`、`SparseAssociationInput`、`FamilyReference`、`DecisionPolicy`；
- AI 结果不能产生 `user_confirmed`，也不能直接写长期 Memory；
- `association-rules.1` 保留为可复现 baseline，新策略默认 shadow。

Gate：全栈可以读取 JSON Schema、TypeScript 类型、正反样例和错误语义。

### T0-A：稀疏组织工程基线

- 实现 `Stage A Observation/Group → ContentObservation`；
- 为独立文字和 final ASR 定义 extractor 接口；
- 新组织器只消费候选边，不自行枚举所有 active pair；
- 提供 exact/in-memory top-K 基线和可追溯 fallback。

Gate：250 项输入不产生全量 pair；输出边数受 `N×K` 限制；跨 scope、撤回、无 Evidence 的边为 0；既有 fixture 可复现。

### T0-B：30–50 组真实素材准备

- 生成 manifest、派生图、哈希、授权引用、冻结真值和 leakage group；
- 同一事件、连拍、裁切、翻拍和近重复不跨分区；
- 人物匹配默认关闭，单独授权后才启用；
- 冻结本地模型、依赖、权重和 license manifest。

Gate：离线 preflight 无阻断；失败保留在固定分母；原始家庭媒体不提交 Git。

### T0-C：离线固定分母评测

- 先运行 Fake、本地规则与失败路径；
- 获得精确批准后才运行真实 Provider；
- 报告抽取、候选召回、分组、错误合并/拆分、请求、token、费用和时延。

硬 Gate：100% 输出可追溯；高风险静默动作 0；跨家庭/主体串数据 0；删除/撤回派生残留 0。语义数值 Gate 在 exploration 后、查看独立 holdout 前冻结。

### T1-A：本地实验台后端

- 浏览器只调用 Next.js BFF，不直接提交可信目录或调用内部 Provider；
- 服务端构建授权目录、哈希和 consent，并切换 Fake/真实 Provider；
- 实现本地任务状态、幂等、取消、有限重试和 last-known-good；
- 页面刷新后可以恢复结果，密钥不进入浏览器。

### T1-B：轻量分类实验页

- 上传单图/多图；
- 输入单图说明、批次说明和 final ASR；
- 切换相册上传/家庭互传；
- 展示进度、标签、StoryUnit、人物组、标题摘要、Evidence、风险、费用和时延；
- 支持接受、移出、拆分、合并、拒绝、删除和撤回。

Gate：核心组合场景无崩溃；每项结果可展开到 Evidence；高风险动作必须确认。

### T1-C：验收与交接

- 自动化与浏览器检查；
- 30 项代表批次人工验收；
- 输出接口示例、运行命令、状态机、错误码、T2 adapter 边界和已知缺口。

Gate：30 项达到批准的等待体验；typecheck、分类回归、secret scan 和 diff check 通过；依赖 loopback 的 HTTP 测试在允许本地监听的环境复跑。

## 4. 小提交边界

1. `contracts: freeze hybrid retrieval contracts`
2. `classification: accept sparse association candidates`
3. `classification: bridge stage-a observations`
4. `classification: add bounded exact retrieval baseline`
5. `evaluation: prepare frozen real-media T0 batch`
6. `lab-api: add local classification runtime`
7. `lab-ui: add local classification workbench`
8. `lab-actions: add correction and lifecycle controls`
9. `qa: freeze T1 acceptance and full-stack handoff`

每个提交独立可回退。共享状态机、`package.json`、执行日志和最终交接由主线统一维护。

## 5. 全栈交付清单

- 版本化 JSON Schema、TypeScript 类型、合法/非法 fixtures；
- API 请求/响应示例和错误码表；
- Evidence、StoryUnit、Association、FamilyReference、DecisionPolicy 的权威边界；
- Fake Provider 和一键本地演示；
- Provider 的服务端切换方式及无凭据默认路径；
- 任务状态机、幂等、取消、重试、晚到结果拒收和 last-known-good 规则；
- 删除/撤回传播和 scope 隔离测试；
- 30–50 组素材的脱敏 manifest、固定分母 T0 报告及 T1 操作记录；
- T1 浏览器验收证据、自动化结果和已知失败；
- T2 数据库、队列、对象存储和鉴权 adapter 接口与未实现项；
- T3 数据隔离规则。

完成的判断是：全栈无需猜测算法隐含语义，就能用 Fake 启动主链、读取契约、复现 T1，并把本地 store/provider adapter 替换为 T2 基础设施。

## 6. 证据边界

- T0/T1 通过只证明当前素材上的算法行为和本地 Alpha 可行；
- 合成数据只证明工程、异常和契约行为；
- 30–50 组真实素材不证明跨家庭泛化；
- `0.80/0.55` 只作为旧 baseline，不是模型概率或生产阈值；
- 任何 AI 候选都不能自动升级为用户确认事实或长期 Memory。
