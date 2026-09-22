# 自动分类阶段 A：实现边界与方法

2026-09-14。依据总控 implementation-brief 的 D1–D3；本轮新增真实算法编排/Provider/Prompt/关系与纠错，保留 v1 Fake。未获付费批次授权。

完成条件：严格五维观察；多图API适配；少量身份参考与未知分组；事件类型与实例分离；纠错和增量依赖失效；真实评测预检/执行脚本；本地行为测试与分层报告。重大外部含义保持草案，不自动提交或改业务库。

## 开源优先审阅与取舍

- Immich（https://github.com/immich-app/immich；AGPL-3.0）：官方 https://docs.immich.app/features/facial-recognition/ 展示检测、识别、增量分组、命名及合并；阅读其增量索引与纠错思路，不复制源码、不下载模型。其 embedding/DBSCAN/图库服务不直接满足用户当前 VLM API 优先及 SGX 来源/授权契约。
- LibrePhotos（https://github.com/LibrePhotos/librephotos；https://github.com/LibrePhotos/librephotos/blob/dev/LICENSE）：作为完整照片管理项目参考，已核对根LICENSE为MIT；不同模型与子依赖许可不据此继承；不复制源码或引入服务。
- 复用现有 Zod 与 Node fetch/crypto，实现 SGX 特有的候选依赖、受限事件关联和纠错编排；既有 Ajv/v1契约不更换。不引入通用workflow框架、自部署人脸模型或向量数据库。

## 增量设计

新增 stage-a-* 模块；独立契约版本，不把新字段塞入v1。主链为：可信授权快照 → 输入/来源哈希 → 变化与依赖失效 → 五维抽取 → 有界历史候选筛选 → 多图人物/事件复核 → 不冲突的候选关联图 → 事件/人物分组及纠错差异。全栈保存算法快照和业务确认事实，算法只返回更新结果。

模型响应均不可信；严格校验结构、引用、精度和状态，不把模型置信度当概率。人物姓名来自可信参考/用户纠错，不允许模型自由编造身份。图像/说明/历史文字全部为数据，不能成为系统指令。保留unknown、冲突和失败。

自动形成的是可纠正的AI分组；无法证实的关系保留疑难项，不用同类型/日期近/相似衣服直接合并。候选筛选预算与缺口显式回报，正式模型阈值/效果门槛由D4探索后冻结。
