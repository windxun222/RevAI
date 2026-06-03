# RevAI — AI PR Review Assistant

[English](#english) | [中文](#chinese)



## <a id="english"></a>English

### Overview

RevAI is an AI-powered Pull Request review tool for GitHub. Paste any public PR URL, and RevAI automatically performs a multi-dimensional analysis — **security**, **code quality**, and **code style** — producing a structured report with actionable suggestions. The analysis engine is a **dual-layer architecture**: lightweight deterministic rules run locally in under 3 seconds, while deep semantic analysis is powered by **DeepSeek** (`deepseek-chat`).

### Why RevAI?

Manual PR review is time-consuming and inconsistent. Reviewers miss subtle bugs, overlook security vulnerabilities, and waste energy on style nits. RevAI automates the mechanical inspection layer so human reviewers can focus on architecture, design intent, and business logic.

Key design principles:

- **Speed-first L1**: Deterministic regex + structural analysis runs synchronously on every `+` line. No network calls. Results in < 3 seconds.
- **Deep L2 streaming**: Each changed file is sent to DeepSeek with rich context (80-line window + file structure). Findings stream back one-by-one via SSE — no waiting for the full batch.
- **Cross-validation**: When L1 and L2 independently flag the same issue, confidence is boosted (+0.15), reducing false positives.
- **User feedback loop**: Mark findings as "Ignored" or "False Positive" to train your mental model of what matters.

### How It Works — Step by Step

```
┌──────────────────────────────────────────────────────────────┐
│  1. User pastes GitHub PR URL                                │
│     e.g. https://github.com/owner/repo/pull/123               │
└─────────────────────┬────────────────────────────────────────┘
                      ▼
┌──────────────────────────────────────────────────────────────┐
│  2. Backend fetches PR metadata + diff via GitHub REST API    │
│     (Octokit: pulls.get + pulls.listFiles with pagination)    │
│     - PR title, description, author, branch info              │
│     - Per-file patch (added/removed lines + context)          │
│     - Full unified diff reconstruction                        │
└─────────────────────┬────────────────────────────────────────┘
                      ▼
┌──────────────────────────────────────────────────────────────┐
│  3. L1 Static Analysis (synchronous, < 3s, progress: 15→40)  │
│     - 12 deterministic rules scan every "+" line in the diff  │
│     - Security: secret leaks, SQLi, XSS, path traversal,      │
│       weak crypto, sensitive logging                          │
│     - Quality: null refs, empty catch, resource leak,         │
│       race condition hint, unreachable code                   │
│     - Style: magic numbers, missing error handling,           │
│       leftover console.log                                    │
│     - Confidence scores: 0.15–0.95 per rule                   │
│     - QUAL-001 has 35-safe-globals whitelist to reduce noise   │
└─────────────────────┬────────────────────────────────────────┘
                      ▼
┌──────────────────────────────────────────────────────────────┐
│  4. L2 AI Semantic Analysis (streaming, progress: 40→90)      │
│     - Each changed file is sent to DeepSeek deepseek-chat     │
│     - Context window: 80 lines surrounding each hunk          │
│     - Prompt includes: file structure, hunk diffs, PR title   │
│     - stream: true — each JSONL finding emitted as it arrives │
│     - 3 concurrent files, batch-parallel within each group    │
│     - System message: "Return one JSON object per line (JSONL)"│
│     - Confidence filter: L2 < 0.7 excluded at aggregation     │
│     - If DEEPSEEK_API_KEY is not set: L2 gracefully skipped    │
└─────────────────────┬────────────────────────────────────────┘
                      ▼
┌──────────────────────────────────────────────────────────────┐
│  5. Aggregation & Cross-Validation                            │
│     - Merge L1 + L2 finding arrays                            │
│     - Dedup by (same file, line diff ≤ 2, same category)      │
│     - Cross-validate: L1+L2 hit on same location → +0.15 conf │
│     - Filter L2 findings with confidence < 0.7                │
│     - Sort by severity (critical → warning → info), then conf │
└─────────────────────┬────────────────────────────────────────┘
                      ▼
┌──────────────────────────────────────────────────────────────┐
│  6. Summary Generation (DeepSeek)                              │
│     - One-sentence PR intent summary                          │
│     - Risk level assessment: low / medium / high              │
│     - Module extraction: affected components/modules list     │
│     - Without L2: heuristics based on file count               │
└─────────────────────┬────────────────────────────────────────┘
                      ▼
┌──────────────────────────────────────────────────────────────┐
│  7. Results delivered to browser via SSE                      │
│     - Progress events every 500ms (polled)                    │
│     - Finding events: pushed in real-time as L2 streams       │
│     - Complete event: final summary + all findings + stats    │
│     - Fallback: GET /api/analyze/:id for polling clients      │
└──────────────────┬───────────────────────────────────────────┘
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  8. Frontend renders interactive report                       │
│     - SummaryCard: intent, risk badge, file/add/del stats     │
│     - SeverityChart: stacked bar + category breakdown         │
│     - FindingList: filter by category/severity, sort, ignore  │
│     - FindingCard: severity icon, confidence %, expand detail │
│     - DiffViewer: Monaco Editor with file tabs + finding marks│
│     - ReviewPublisher: select findings → post as PR review    │
└──────────────────────────────────────────────────────────────┘
```

### Interactive Features

| Feature | Description |
|---------|-------------|
| **Progress streaming** | SSE-based real-time progress bar showing L1/L2 completion status and finding count |
| **Incremental findings** | L2 findings appear one-by-one in the UI as DeepSeek streams them — no waiting for full batch |
| **Filtering & sorting** | Filter by category (security/quality/style), severity (critical/warning/info), sort by severity/confidence/file |
| **Expand/collapse** | Each finding card expands to show description, suggestion, and code snippet |
| **Diff navigation** | Click a finding to jump directly to the relevant file and line in the diff viewer |
| **Ignore / False Positive** | Two distinct buttons: Ignore (hides noise) or Flag as False Positive (feedback for improvement) |
| **GitHub integration** | Select findings and post them as a formatted PR Review directly to GitHub |
| **Token support** | Optional GitHub Personal Access Token for private repos and higher API rate limits |

### Data Flow & Type System

```
┌──────────────────────────────────────────────────────┐
│                    Finding (核心/核心)                  │
│  id, file, line, category, severity, title,           │
│  description, suggestion, codeSnippet, confidence,    │
│  source (L1|L2), ruleId?, userFeedback?               │
└──────────────────────────────────────────────────────┘
         ▲                    ▲
         │                    │
    ┌────┴─────┐      ┌──────┴──────┐
    │ L1 Engine │      │ L2 DeepSeek │
    │ 12 rules  │      │  streaming  │
    │ < 3 sec   │      │  5-20 sec   │
    └───────────┘      └─────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │   Aggregator    │
                    │ merge + dedup   │
                    │ cross-validate  │
                    │ filter + sort   │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │  SSE Stream     │
                    │ progress events │
                    │ finding events  │
                    │ complete event  │
                    └─────────────────┘
```

### API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check — returns `{ status, version }` |
| `POST` | `/api/analyze` | Start analysis — body: `{ prUrl, githubToken? }` → `{ id, status }` |
| `GET` | `/api/analyze/:id` | Get full analysis result (polling alternative to SSE) |
| `GET` | `/api/analyze/:id/stream` | SSE stream — pushes `progress`, `finding`, and `complete` events |
| `PUT` | `/api/analyze/:id/findings/:fid/feedback` | Mark finding — body: `{ feedback: 'ignored' \| 'false_positive' }` |
| `POST` | `/api/analyze/:id/post-review` | Post findings as GitHub PR Review — body: `{ findingIds, githubToken }` |

### SSE Event Types

| Event Type | When | Payload |
|-----------|------|---------|
| `progress` | Every 500ms during analysis | `{ type, status, progress, l1Complete, l2Complete, findingsCount }` |
| `finding` | Real-time as each L2 finding is parsed | `{ type: 'finding', finding: Finding }` |
| `complete` | Analysis finished (success or error) | `{ type, status, summary, findings, stats, error? }` |

### L1 Rules — Detailed Reference

#### Security (6 rules)

| ID | Name | Pattern | Confidence |
|----|------|---------|------------|
| SEC-001 | Hardcoded Secret | API key patterns (`sk-`, `ghp_`, `AKIA`), JWT, `password=`, `token=` | 0.95 |
| SEC-002 | SQL Injection | `SELECT/INSERT/UPDATE/DELETE` + string concatenation (`+` or `${`) without `?` params | 0.85 |
| SEC-003 | XSS Risk | `innerHTML`, `outerHTML`, `document.write()`, `dangerouslySetInnerHTML` | 0.80 |
| SEC-004 | Path Traversal | `readFile`/`open`/`path.join` with `req.`/`params.`/`query.`/`body.` input, no sanitization | 0.75 |
| SEC-005 | Weak Crypto | `md5`/`sha1`/`des`/`rc4` + `hash`/`encrypt`/`cipher`/`digest` context | 0.90 |
| SEC-006 | Sensitive Log | `console.log`/`logger.info` with `password`/`token`/`secret`/`credential` in args | 0.85 |

#### Quality (5 rules)

| ID | Name | Pattern | Confidence |
|----|------|---------|------------|
| QUAL-001 | Null Reference | `identifier.identifier` without `?.` or `if (` guard; skips 35 safe globals (Math, console, JSON, etc.) | 0.55 |
| QUAL-002 | Empty Catch | Structural brace-depth analysis of `catch` block body for non-comment, non-whitespace content | 0.95 |
| QUAL-003 | Resource Leak | `fs.open()`/`createWriteStream`/`createReadStream`/`createConnection` without `.close()`/`.disconnect()`/`finally` within 5 lines | 0.60 |
| QUAL-004 | Race Condition | `await` + `++`/`--`/`+=`/`-=` on same line (excludes `for await`); confidence deliberately low — single-threaded event loop | 0.15 |
| QUAL-005 | Unreachable Code | Non-`}`/non-comment line immediately after `return`/`throw` | 0.75 |

#### Style (3 rules)

| ID | Name | Pattern | Confidence |
|----|------|---------|------------|
| STYLE-001 | Magic Number | 3+ digit numeric literal (not 0/1/2/100), not in `import`/`const`/`enum`/`version` line | 0.65 |
| STYLE-002 | No Error Handling | `await` without `try {`/`.catch(`/`catch (` within ±5 lines | 0.55 |
| STYLE-003 | Console Statement | `console.log`/`debug`/`warn` without `eslint-disable` comment | 0.70 |

### False Positive Mitigation — Four-Layer Strategy

```
Layer 1: L1 Confidence Calibration
  └─ Rules assigned calibrated scores (0.15–0.95)
  └─ QUAL-001 whitelists 35 safe global identifiers
  └─ QUAL-003 scans ±5 lines for cleanup, not just same line
  └─ QUAL-004 lowered to 0.15, skips `for await`

Layer 2: L2 Confidence Threshold
  └─ L2 findings with confidence < 0.7 are filtered out at aggregation

Layer 3: L1+L2 Cross-Validation
  └─ Same file, line diff ≤ 2, same category → confidence boosted +0.15
  └─ Description marked "[Confirmed by AI analysis]"

Layer 4: User Feedback
  └─ Ignore button: hide noise from the default view
  └─ False Positive (Flag) button: explicitly mark as FP
  └─ Both dim the card (opacity-40), excluded from ReviewPublisher
```

### Project Structure

```
revai/
├── .env                        # DEEPSEEK_API_KEY=sk-...
├── README.md
├── package.json                # Root: concurrently runs server + client
│
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts            # Express app entry (port 3001)
│   │   ├── types.ts            # Finding, PrMetadata, AnalysisResult, etc.
│   │   ├── routes/
│   │   │   └── analyze.ts      # All API routes + runAnalysis orchestrator + SSE
│   │   ├── services/
│   │   │   ├── github.ts       # Octokit: parse PR URL, fetch PR data + diff
│   │   │   └── deepseek.ts     # L2: streaming deepseek-chat, JSONL parsing, summary
│   │   └── analysis/
│   │       ├── L1-engine.ts    # 12 deterministic rules with per-line checking
│   │       ├── context-builder.ts  # Hunk extraction, file structure, LLM prompt
│   │       └── aggregator.ts   # Merge L1+L2, dedup, cross-validate, filter, sort
│   └── dist/                   # Compiled JavaScript (tsc output)
│
├── client/
│   ├── package.json
│   ├── vite.config.ts          # Vite + React + /api proxy → localhost:3001
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx             # Top-level: view routing (home ↔ analysis)
│   │   ├── types/index.ts      # Client-side Finding, StreamEvent, etc.
│   │   ├── lib/api.ts          # API client: startAnalysis, createAnalysisStream, etc.
│   │   ├── pages/
│   │   │   ├── Home.tsx        # PR URL input, token field, analysis kickoff
│   │   │   └── Analysis.tsx    # Main results page: progress, findings, diff, publish
│   │   └── components/
│   │       ├── ProgressBar.tsx   # Animated gradient progress bar
│   │       ├── SummaryCard.tsx   # Intent + risk badge + file/add/del/findings stats
│   │       ├── SeverityChart.tsx # Stacked severity bars + category breakdown
│   │       ├── FindingCard.tsx   # Individual finding: severity icon, expand, ignore/FP
│   │       ├── FindingList.tsx   # Filterable, sortable list of FindingCards
│   │       ├── DiffViewer.tsx    # Monaco Editor diff with file tabs + finding markers
│   │       └── ReviewPublisher.tsx # Modal: select findings → post GitHub PR Review
│   └── dist/                   # Vite production build output
│
└── node_modules/
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend Framework | React 18 + TypeScript |
| Build Tool | Vite 5 |
| Styling | Tailwind CSS 3 |
| Code Editor | Monaco Editor (`@monaco-editor/react`) |
| Icons | Lucide React |
| Backend Runtime | Node.js + Express 4 |
| GitHub API | Octokit (`@octokit/rest`) |
| AI SDK | OpenAI Node.js SDK (DeepSeek compatible) |
| AI Model | DeepSeek `deepseek-chat` |
| Streaming | SSE (Server-Sent Events) + OpenAI stream mode |
| Concurrency | `Promise.allSettled` with batch size 3 |

### Quick Start

**Prerequisites**: Node.js ≥ 18, npm ≥ 9

```bash
# 1. Clone and install
git clone <repo-url> && cd revai
npm run install:all

# 2. Configure AI (optional but recommended)
echo "DEEPSEEK_API_KEY=sk-your-key-here" > .env

# 3. Build server
cd server && npm run build && cd ..

# 4. Start both server and client
npm run dev
# Server: http://localhost:3001
# Client: http://localhost:5173
```

Or run separately:

```bash
# Terminal 1 — Server
cd server && DEEPSEEK_API_KEY=sk-... node dist/index.js

# Terminal 2 — Client
cd client && npx vite
```

Open `http://localhost:5173`, paste a GitHub PR URL, and click **Analyze PR**.

**Without a DeepSeek API key**: The tool still works — L1 rules run and produce a complete report. Only the L2 AI semantic analysis and summary generation are skipped.

### Observing L2 in Action

To confirm L2 is actively working during an analysis:

1. **Browser DevTools → Network tab** → filter by `stream` → open the EventSource request. You'll see SSE messages arriving: `type: 'progress'` (every 500ms), `type: 'finding'` (each L2 finding as it streams from DeepSeek), and `type: 'complete'` (final).

2. **Server terminal**: Look for `[DeepSeek]` log lines — e.g., `[DeepSeek] src/App.tsx: 3 findings (streaming)` confirms streaming mode is active.

3. **UI indicator**: The L2 DeepSeek status badge in the progress bar changes from a spinning loader to a green checkmark when complete, with a count of L2 findings.

4. **Finding source badges**: Each FindingCard shows either a ⚡ `Zap` icon (L1) or a 🔲 `Cpu` icon (L2) next to the confidence percentage.

---

## <a id="chinese"></a>中文

### 概述

RevAI 是一个 AI 驱动的 GitHub Pull Request 代码评审工具。输入任意公开 PR 链接，RevAI 自动从**安全性**、**代码质量**、**代码风格**三个维度进行智能分析，输出结构化评审报告 —— 由 **DeepSeek** (`deepseek-chat`) 提供 AI 语义分析能力。

核心引擎采用**双层架构**：轻量级确定性规则在本地毫秒级运行（L1），深度语义分析通过 DeepSeek 流式返回结果（L2）。

### 设计动机

人工 PR Review 面临三个痛点：**耗时长**（大 PR 动辄数小时）、**标准不一**（不同 reviewer 关注点不同）、**遗漏风险**（安全漏洞和隐蔽 bug 容易被忽略）。RevAI 将机械化的代码检查层自动化，让人类 reviewer 专注于架构设计、业务逻辑和设计意图。

### 核心设计原则

- **L1 速度优先**：12 条确定性规则纯本地运行，无网络调用，< 3 秒完成。每条 `+` 行逐一匹配正则和结构模式。
- **L2 流式深度分析**：每个变更文件连同 80 行上下文和文件结构送至 DeepSeek。通过 `stream: true` 启用真正的流式传输，每个发现通过 SSE 实时推送到前端 —— 无需等待整批完成。
- **交叉验证降低误报**：当 L1 和 L2 独立标记同一处问题时，置信度 +0.15，标记 `[Confirmed by AI analysis]`。
- **用户反馈闭环**：每个 Finding 提供 "忽略"（Ignore）和 "误报"（False Positive）两个独立按钮，形成持续改进循环。

### 工作流程详解

```
用户粘贴 PR URL
    ↓
后端通过 GitHub REST API 拉取 PR 元数据 + diff
  (Octokit: pulls.get + pulls.listFiles 分页获取)
    ↓
L1 静态分析（同步，< 3 秒，进度 15→40）
  12 条规则逐行扫描 diff 的 + 行：
  安全(6): 密钥泄露/SQL注入/XSS/路径遍历/弱加密/敏感日志
  质量(5): 空指针/空catch/资源泄漏/竞态提示/不可达代码
  风格(3): 魔法数字/缺少错误处理/遗留console.log
    ↓
L2 AI 语义分析（流式，进度 40→90）
  每个变更文件 → DeepSeek deepseek-chat
  上下文窗口: 每个 hunk 周围 80 行 + 文件结构提取
  3 文件并发, stream: true, JSONL 逐行解析
  每个 finding 解析后立即通过 EventEmitter → SSE 推送到前端
  无 DEEPSEEK_API_KEY 时优雅降级，仅跳過 L2
    ↓
结果聚合与交叉验证
  L1 + L2 合并 → 去重(同文件+行号差≤2+同类别)
  → 交叉验证置信度+0.15 → 过滤 L2<0.7 → 按严重度排序
    ↓
摘要生成 (DeepSeek)
  意图总结 + 风险评级 + 受影响模块列表
    ↓
SSE 推送至浏览器
  progress 事件(每500ms) + finding 事件(实时) + complete 事件(最终)
    ↓
前端渲染交互式报告
  SummaryCard → SeverityChart → FindingList → FindingCard → DiffViewer → ReviewPublisher
```

### 误报控制 — 四层策略

```
第一层: L1 置信度校准
  ├─ 每条规则独立校准 (0.15~0.95)
  ├─ QUAL-001 白名单 35 个安全全局标识符 (Math, console, JSON...)
  ├─ QUAL-003 检查当前行 + 后续 5 行的清理调用
  └─ QUAL-004 降至 0.15, 跳过 for await 模式

第二层: L2 置信度阈值
  └─ L2 发现 confidence < 0.7 在聚合阶段过滤

第三层: L1+L2 交叉验证
  └─ 同文件 + 行差 ≤ 2 + 同类别 → 置信度 +0.15

第四层: 用户反馈
  ├─ Ignore (忽略): 隐藏无关噪音
  └─ False Positive (误报): 显式标记误报
  └─ 二者均使卡片半透明(opacity-40)，ReviewPublisher 自动排除
```

### SSE 事件类型

| 事件类型 | 触发时机 | 数据内容 |
|---------|---------|---------|
| `progress` | 分析中每 500ms | `{ type, status, progress, l1Complete, l2Complete, findingsCount }` |
| `finding` | 每个 L2 发现解析后实时推送 | `{ type: 'finding', finding: Finding }` |
| `complete` | 分析完成（成功或失败） | `{ type, status, summary, findings, stats, error? }` |

### 观察 L2 实时工作

分析过程中可通过以下方式确认 L2 流式模式正在运行：

1. **浏览器 DevTools → Network 标签页** → 筛选 `stream` → 打开 EventSource 请求，可看到 SSE 消息逐步到达：`type: 'progress'`（每 500ms）、`type: 'finding'`（每个 L2 发现实时到达）、`type: 'complete'`（最终）。

2. **服务端终端**：观察 `[DeepSeek]` 日志行 —— 例如 `[DeepSeek] src/App.tsx: 3 findings (streaming)` 确认流式模式已启用。

3. **UI 进度指示器**：进度条中的 "L2 DeepSeek" 状态徽章从旋转加载图标变为绿色对勾，并显示 L2 发现数量。

4. **Finding 来源徽章**：每张 FindingCard 在置信度百分比旁显示 ⚡ 图标（L1）或 🔲 图标（L2）。

### API 接口速查

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 健康检查 |
| `POST` | `/api/analyze` | 提交分析 — body: `{ prUrl, githubToken? }` |
| `GET` | `/api/analyze/:id` | 获取完整分析结果 |
| `GET` | `/api/analyze/:id/stream` | SSE 实时流 |
| `PUT` | `/api/analyze/:id/findings/:fid/feedback` | 标记 finding — body: `{ feedback }` |
| `POST` | `/api/analyze/:id/post-review` | 发布到 GitHub PR Review |

### 项目结构

```
revai/
├── server/                     # Express 后端 (端口 3001)
│   └── src/
│       ├── index.ts            # 应用入口
│       ├── types.ts            # 类型定义
│       ├── routes/analyze.ts   # API 路由 + 分析编排 + SSE
│       ├── services/
│       │   ├── github.ts       # GitHub API 封装 (Octokit)
│       │   └── deepseek.ts     # L2 流式分析 + JSONL 解析 + 摘要生成
│       └── analysis/
│           ├── L1-engine.ts    # 12 条确定性规则引擎
│           ├── context-builder.ts  # Hunk 提取 + LLM 提示词构建
│           └── aggregator.ts   # 合并 + 去重 + 交叉验证 + 排序
│
├── client/                     # React 前端 (端口 5173)
│   └── src/
│       ├── pages/
│       │   ├── Home.tsx        # PR URL 输入页
│       │   └── Analysis.tsx    # 分析结果页
│       └── components/
│           ├── ProgressBar.tsx     # 进度条
│           ├── SummaryCard.tsx     # 摘要卡片
│           ├── SeverityChart.tsx   # 严重度图表
│           ├── FindingCard.tsx     # 发现卡片 (Ignore/FP按钮)
│           ├── FindingList.tsx     # 发现列表 (筛选/排序)
│           ├── DiffViewer.tsx      # Diff 查看器 (Monaco)
│           └── ReviewPublisher.tsx # 发布到 GitHub
│
└── .env                        # DEEPSEEK_API_KEY=sk-...
```

### 技术栈

| 层级 | 技术选型 |
|------|---------|
| 前端框架 | React 18 + TypeScript |
| 构建工具 | Vite 5 |
| 样式 | Tailwind CSS 3 |
| 代码编辑器 | Monaco Editor |
| 图标 | Lucide React |
| 后端运行时 | Node.js + Express 4 |
| GitHub API | Octokit REST |
| AI SDK | OpenAI Node.js SDK (兼容 DeepSeek) |
| AI 模型 | DeepSeek `deepseek-chat` |
| 流式传输 | SSE + OpenAI stream mode |

### 快速开始

**环境要求**: Node.js ≥ 18, npm ≥ 9

```bash
# 1. 克隆并安装依赖
git clone <repo-url> && cd revai
npm run install:all

# 2. 配置 AI（可选但推荐）
echo "DEEPSEEK_API_KEY=sk-你的密钥" > .env

# 3. 构建后端
cd server && npm run build && cd ..

# 4. 同时启动前后端
npm run dev
# 后端: http://localhost:3001
# 前端: http://localhost:5173
```

或分别启动：

```bash
# 终端 1 — 后端
cd server && DEEPSEEK_API_KEY=sk-... node dist/index.js

# 终端 2 — 前端
cd client && npx vite
```

浏览器打开 `http://localhost:5173`，粘贴 GitHub PR 链接，点击 **Analyze PR** 开始分析。

**未配置 DeepSeek API Key**：工具仍可正常使用 —— L1 规则完整运行并输出报告，仅跳过 L2 AI 语义分析和摘要生成。

### 设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| AI 模型 | DeepSeek `deepseek-chat` | 代码理解能力接近 GPT-4o，成本显著更低，完全兼容 OpenAI SDK |
| L1 实现方式 | 正则 + 结构化分析 | 无需网络、确定性输出、< 3 秒完成、适合 CI 集成 |
| L2 上下文窗口 | 80 行 | 平衡 prompt token 消耗与语义理解充分性 |
| 流式传输 | SSE + OpenAI stream | 用户无需等待全部分析完成即可看到中间结果 |
| JSON 格式 | JSONL (逐行) | 支持流式逐行解析，每行一个完整的 finding 对象 |
| 并发策略 | 3 文件并发 | 避免 DeepSeek API 速率限制，保持可控并发 |
| 置信度模型 | 硬编码 + 交叉验证 | L1 置信度基于规则精度校准，L2≤0.7 过滤，双重命中 +0.15 |
| Git 集成 | Octokit REST | 官方 SDK，完整类型支持，处理分页 |
