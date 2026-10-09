# AI 回忆录助手

> 面向老年用户的智能人生故事记录与回忆录生成系统

一个通过温和，专业、长期可持续的对话，引导老人讲述自己的人生故事，并最终生成高质量、可编辑、可评分优化的人生回忆录的AI助手。

## 自动分类与归纳模块（全栈先读）

**2026-10-09 最新接入方式**：[全栈直接调用算法 API：路由、字段、流程图与接入步骤](docs/algorithms/CLASSIFICATION_DIRECT_API_INTEGRATION_2026-10-09.md)。完整算法入口 `127.0.0.1:8765`，内部组件 `8766`；全栈负责公网 HTTPS 映射与产品存储，外部不再实现 Worker pull 控制面。

[独立 API 部署说明](deploy/classification-api/README.md)、[OpenAPI](deploy/classification-api/openapi.yaml)、[本轮执行计划](docs/algorithms/CLASSIFICATION_DIRECT_API_PLAN_2026-10-09.md) 和 [最新运行/验证记录](docs/execution/2026-10-09-execution-log.md)。旧文档中的 Worker 对外接入要求已被本次决策取代，模型与核心算法配置沿用。

历史交接说明：[2026-10-08 文件清单与恢复证据](docs/algorithms/CLASSIFICATION_FULLSTACK_FORWARD_BRIEF_2026-10-08.md)。

第一次接手请先读 [全栈工程师接手说明：阅读顺序、任务、阶段与验收](docs/algorithms/CLASSIFICATION_FULLSTACK_TAKEOVER_GUIDE_2026-10-07.md)。

2026-10-08 历史服务排查见 [云端服务恢复记录](docs/algorithms/CLASSIFICATION_SERVICE_RECOVERY_2026-10-08.md)。后续进程退出和新的独立 API 运行状态以 2026-10-09 执行记录为准。

当前 T0/T1 内部候选已接入真实 Qwen、多图/文字、OCR、image/text embedding、授权后匿名人物候选、StoryUnit 组织和 Worker 结果持久化。全栈接入从以下文档开始：

- [全栈交付 README](docs/algorithms/CLASSIFICATION_FULLSTACK_DELIVERY_README_V1.md)
- [完整算法架构与功能](docs/algorithms/CLASSIFICATION_ALGORITHM_COMPLETE_GUIDE.md)
- [全栈接入指南](docs/algorithms/CLASSIFICATION_FULLSTACK_INTEGRATION_GUIDE_V2.md)
- [2026-10-04 真实多图复测](docs/algorithms/CLASSIFICATION_T1_REAL_MULTI_IMAGE_RETEST_2026-10-04.md)
- [云端 Worker 部署与回滚](deploy/classification-worker/README.md)
- [2026-10-07 定向真实复测与交付边界](docs/algorithms/CLASSIFICATION_T1_TARGETED_RETEST_2026-10-07.md)
- [当前执行计划与 T2 分工](docs/superpowers/plans/2026-10-07-classification-targeted-handoff-execution-plan.md)

当前云端完整 API release 为 `87631dadb8cf9ece27eec96fe742033a4d3c8cef`，核心算法沿用 `82cab23`；GitHub 交付分支为 `codex/classification-t1-external-20261006`。同会话两轮真实图文证据继续沿用；新 API 真实 ASR、结果持久化与进程恢复已验证。最新运行状态以 [2026-10-09 执行记录](docs/execution/2026-10-09-execution-log.md) 为准：组件 ready，完整分类等待 Qwen secret，公网 HTTPS 由全栈映射；不能将进程 health=200 当作完整分类 ready。

当前结论是“真实模型功能链已跑通”，不是现实家庭数据准确率或生产发布结论。产品后端仍需完成 T2 的鉴权、业务数据库、对象存储、队列、监控和内部用户环境部署。

## 功能特点

### 🎯 核心功能
- **多轮访谈系统**：分阶段进行，从破冰到深度回忆，逐步建立人生时间线
- **记忆结构化**：自动从访谈中提取人物、事件、地点、情感等结构化信息
- **多风格回忆录生成**：支持朴素记叙、清丽抒情、乡土温润等多种文风
- **双AI评审机制**：Interviewer-Writer AI 生成初稿，Editor-Critic AI 评分优化
- **多格式导出**：支持章节版，短篇纪实版、散文版、家族留存版等
- **多Provider兼容**：支持硅基流动、OpenAI、火山引擎、通义千问、智谱等多种AI平台

### 👴 老年友好设计
- 大字体、高对比度界面
- 一次只问一个问题
- 支持跳过、暂停、稍后再说
- 自动保存访谈进度
- 明确的进度感
- **温暖、克制、治愈的视觉风格**

### 🔧 技术架构
- **前端**：Next.js 14 + React + TypeScript + Tailwind CSS
- **后端**：Next.js API Routes
- **数据库**：JSON 文件存储（可扩展到 PostgreSQL/MongoDB）
- **AI**：OpenAI Compatible API (支持多Provider)

## 快速开始

### 1. 安装依赖

```bash
cd ai-memoir-assistant
npm install
```

### 2. 配置环境变量

在项目根目录创建 `.env.local` 文件：

#### 方式一：使用统一变量（推荐）

```bash
# 统一 LLM 配置
LLM_PROVIDER=siliconflow
LLM_API_KEY=sk-your-api-key-here
LLM_MODEL=Qwen/Qwen2.5-7B-Instruct

# 可选配置
LLM_BASE_URL=
LLM_TEMPERATURE=0.7
LLM_MAX_TOKENS=2048
LLM_TIMEOUT_MS=60000
```

#### 方式二：使用平台专用变量

```bash
# 硅基流动 API (推荐)
SILICONFLOW_API_KEY=sk-your-api-key-here
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_MODEL=Qwen/Qwen2.5-7B-Instruct

# OpenAI 官方
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-3.5-turbo

# 火山引擎
VOLCENGINE_API_KEY=your-api-key
VOLCENGINE_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
VOLCENGINE_MODEL=doubao-pro-32k

# 通义千问
QWEN_API_KEY=your-api-key
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen-turbo

# 智谱
ZHIPU_API_KEY=your-api-key
ZHIPU_BASE_URL=https://open.bigmodel.cn/api/paas/v4
ZHIPU_MODEL=glm-4-flash
```

### 3. 创建数据目录

```bash
mkdir -p data
```

### 4. 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3000

## 如何切换 AI 平台

### 步骤 1: 获取 API Key

| 平台 | 注册地址 | 推荐模型 |
|------|---------|---------|
| 硅基流动 | https://siliconflow.cn | Qwen/Qwen2.5-7B-Instruct |
| OpenAI | https://platform.openai.com | gpt-3.5-turbo |
| 火山引擎 | https://www.volcengine.com | doubao-pro-32k |
| 通义千问 | https://dashscope.console.aliyun.com | qwen-turbo |
| 智谱 | https://open.bigmodel.cn | glm-4-flash |

### 步骤 2: 配置环境变量

修改 `.env.local` 文件，选择以下任一方式：

#### 快速切换（推荐）

```bash
# 只需修改这三项即可切换平台
LLM_PROVIDER=siliconflow  # 可选: siliconflow, openai, volcengine, qwen, zhipu
LLM_API_KEY=your-api-key
LLM_MODEL=your-preferred-model
```

#### 平台专用变量

```bash
# 切换到 OpenAI
OPENAI_API_KEY=sk-xxx
OPENAI_MODEL=gpt-4

# 切换到火山引擎
VOLCENGINE_API_KEY=xxx
VOLCENGINE_MODEL=doubao-pro-32k
```

### 步骤 3: 重启服务

```bash
npm run dev
```

## 项目结构

```
ai-memoir-assistant/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── api/               # API 路由
│   │   │   ├── chat/          # 对话API
│   │   │   ├── memoir/        # 回忆录生成API
│   │   │   ├── review/        # 评审API
│   │   │   └── user/          # 用户API
│   │   ├── page.tsx           # 主页面
│   │   ├── layout.tsx         # 布局
│   │   └── globals.css        # 全局样式（UI设计系统）
│   ├── lib/                   # 核心库
│   │   ├── db.ts             # 数据库操作
│   │   ├── llm.ts            # LLM 调用封装
│   │   ├── llm/              # 多Provider兼容层
│   │   │   ├── index.ts
│   │   │   ├── client.ts
│   │   │   ├── provider-registry.ts
│   │   │   ├── provider-types.ts
│   │   │   └── providers/
│   │   ├── interview-engine/  # 访谈引擎
│   │   │   ├── index.ts
│   │   │   ├── phase-manager.ts
│   │   │   ├── topic-ranker.ts
│   │   │   └── follow-up-decider.ts
│   │   ├── memory-extractor/ # 记忆提取器
│   │   │   └── index.ts
│   │   └── design-tokens.ts  # UI设计系统
│   ├── types/                 # TypeScript 类型
│   │   └── index.ts          # 类型定义
│   ├── prompts/              # Prompt 模板
│   │   ├── system.md         # 系统提示词
│   │   ├── interviewer.md    # 访谈师提示词
│   │   ├── memoir-writer.md # 回忆录写作者提示词
│   │   ├── critic.md        # 评审者提示词
│   │   ├── rewriter.md      # 重写者提示词
│   │   └── summarizer.md    # 总结器提示词
│   └── data/                  # 数据文件
│       ├── topics.json        # 话题库
│       └── styles.json        # 文风配置
├── data/                      # 运行时数据存储
├── ARCHITECTURE.md            # 架构说明文档
├── TASK_CHECKLIST.md         # 任务清单
├── package.json
├── tsconfig.json
├── tailwind.config.js
├── next.config.js
└── README.md
```

## 使用指南

### 首次使用：用户注册 (Onboarding)

系统会引导用户完成初始化设置：
1. 称呼、年龄段、性别
2. 出生地/成长地
3. 受教育程度
4. 是否使用尊称
5. 偏好文风
6. 敏感话题接受度
7. 每次对话时长偏好
8. 回忆录目标

### 访谈流程

系统分阶段进行访谈：
1. **破冰与信任建立** - 轻松话题，建立关系
2. **基本人生信息** - 年龄、背景
3. **童年与家庭** - 早期记忆
4. **学校与成长** - 教育经历
5. **工作与事业** - 职业生涯
6. **婚恋与家庭生活** - 家庭故事
7. **迁徙与时代变化** - 地理与时代记忆
8. **重大困难与转折** - 人生节点
9. **最骄傲的时刻** - 成就回顾
10. **遗憾、和解、领悟** - 人生感悟
11. **想留给后人的话** - 传承寄语

### 生成回忆录

在积累足够素材后，可以：
1. 选择文风模板
2. 选择生成类型（片段/短篇/章节/全书）
3. AI 生成初稿
4. 评审反馈
5. 多轮优化（最多3轮）
6. 导出成品

## 配置说明

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LLM_PROVIDER` | 统一Provider标识 | - |
| `LLM_API_KEY` | 统一API Key | - |
| `LLM_MODEL` | 统一使用模型 | - |
| `LLM_BASE_URL` | 统一API地址 | - |
| `LLM_TEMPERATURE` | 温度参数 | 0.7 |
| `LLM_MAX_TOKENS` | 最大token数 | 2048 |
| `SILICONFLOW_API_KEY` | 硅基流动API Key | - |
| `OPENAI_API_KEY` | OpenAI API Key | - |
| `VOLCENGINE_API_KEY` | 火山引擎API Key | - |
| `QWEN_API_KEY` | 通义千问API Key | - |
| `ZHIPU_API_KEY` | 智谱API Key | - |

### 推荐模型

| 平台 | 模型 | 特点 |
|------|------|------|
| 硅基流动 | Qwen/Qwen2.5-7B-Instruct | 性价比高，中文能力强 |
| 硅基流动 | Qwen/Qwen2.5-14B-Instruct | 更强，但更贵 |
| 火山引擎 | doubao-pro-32k | 稳定可靠 |
| 通义千问 | qwen-turbo | 快速响应 |
| 智谱 | glm-4-flash | 免费额度 |

## 安全与用户保护

本系统严格遵守以下原则：

1. **不编造关键事实** - 所有内容必须来自用户真实叙述
2. **不擅自确定模糊信息** - 不确定信息标记为"待确认"
3. **敏感话题温和处理** - 战争、疾病、创伤等话题需谨慎
4. **用户控制权** - 支持跳过、暂停、稍后再说
5. **不伤害用户情感** - 避免诱导创伤、制造焦虑

## 常见问题

### 1. 数据库初始化失败

确保 `data` 目录存在，并且有写入权限。

### 2. API 调用失败

- 检查 API Key 是否正确
- 检查网络是否正常
- 确认模型名称是否正确
- 查看控制台错误信息

### 3. 界面显示异常

- 清除浏览器缓存
- 确保使用的是现代浏览器（Chrome/Edge/Firefox/Safari）

### 4. 如何切换AI平台？

只需修改 `LLM_PROVIDER` 环境变量，然后重启服务即可。详细说明见上文"如何切换 AI 平台"部分。

## 扩展指南

### 添加自定义话题

编辑 `src/data/topics.json` 添加新话题。

### 添加新文风

编辑 `src/data/styles.json` 添加新风格。

### 新增AI Provider

在 `src/lib/llm/providers/` 目录下创建新的Provider实现。

## 许可证

MIT License

## 贡献指南

欢迎提交 Issue 和 Pull Request！
