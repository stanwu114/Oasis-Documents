# Oasis Documents - 技术选型调研报告

## 一、标杆项目研究（GitHub）

### 1.1 同类开源项目扫描

| 项目 | Stars | 语言 | 核心定位 | 多模态 | 本地部署 | 与本项目关联度 |
|------|-------|------|----------|--------|----------|----------------|
| **khoj-ai/khoj** | 37.1k | Python | AI 个人知识管理（第二大脑） | 支持 | 支持 | ★★★★★ 最对标 |
| **LanceDB** | 11.4k | Rust + 多语言绑定 | 嵌入式多模态向量数据库 | 原生支持 | 纯本地 | ★★★★★ 核心依赖 |
| **Chroma** | 29.2k | Python/JS/Rust | AI 数据基础设施 | 支持 | 内存/持久化 | ★★★★☆ |
| **Qdrant** | ~20k | Rust | 向量搜索引擎 | 支持 | 需启动服务 | ★★★★☆ |
| **Meilisearch** | 59.2k | Rust | 全文搜索引擎 | 否 | 需启动服务 | ★★★☆☆ |
| **Typesense** | 26.5k | C++ | 全文+向量搜索 | 支持 | 需启动服务 | ★★★☆☆ |

### 1.2 关键发现

**khoj**（最对标项目）的技术路线：
- 后端：Python (Django/FastAPI) + PostgreSQL + 向量存储
- 前端：React / Emacs / Obsidian 插件
- AI：支持本地模型（Ollama/LlamaCpp）和云端模型
- 内容源：文件系统、Notion、GitHub、RSS、Obsidian 等
- 检索：语义搜索 + 对话式问答
- **启示**：纯 Python 后端方案已被验证可行，但桌面端体验不如原生应用

**LanceDB**（向量存储黑马）：
- 唯一真正支持**嵌入式零服务**的多模态向量库
- Node.js 原生绑定：可直接在 Electron 主进程加载
- 支持文本/图像/视频的统一存储与检索
- 内置全文搜索（基于 Tantivy）+ 向量相似度 + SQL 查询
- 零拷贝、Arrow 格式、与 Pandas/Polars/DuckDB 生态互通
- **关键优势**：不需要像 Qdrant/Chroma 那样启动独立服务进程

---

## 二、技术选型决策

### 2.1 决策原则

基于 Oasis 系列产品的设计哲学：
1. **本地优先**：所有敏感数据不上云，模型推理本地运行
2. **一致性**：与 Oasis Meeting 保持技术栈和设计语言的统一
3. **轻量嵌入式**：避免需要维护独立服务进程（如 Docker、后台服务）
4. **多模态原生**：图片、文档、视频的向量化存储不能是"后打补丁"
5. **长期可维护**：选型要考虑社区活跃度、文档完善度、API 稳定性

### 2.2 各层选型

#### 桌面框架：Electron（沿用）

| 方案 | 优势 | 劣势 | 结论 |
|------|------|------|------|
| **Electron** | 与 Meeting 一致；生态成熟；Node 原生能力 | 包体积大 (~150MB) | ✅ 沿用 |
| Tauri | 包体积小 (~10MB)，Rust 安全 | Rust 学习曲线；原生模块绑定复杂 | ❌ 不一致 |
| Flutter Desktop | 跨平台一致 | 与现有 React 生态不兼容 | ❌ 不兼容 |

> 决策理由：Oasis Meeting 已验证 Electron + React 19 + TypeScript + electron-vite 的管线稳定可靠，且你已有运维经验。新项目直接复用这套配置，可以最大程度复用 UI 组件、构建脚本和品牌设计体系。

#### 前端 UI：React 19 + 纯 CSS（沿用 Meeting 体系）

- **状态管理**：zustand（Meeting 已用，轻量无样板）
- **样式体系**：直接沿用 Meeting 的 CSS 变量设计系统（暖纸墨 + 琥珀）
- **组件库**：不引入 AntD/Material 等重型组件库，保持 Meeting 的轻量手写组件风格
- **图片展示**：自研图片网格/瀑布流组件（react-window 虚拟滚动优化大量图片）
- **文件预览**：自研，按需加载（PDF.js、图片懒加载）

#### 数据库层：SQLite + LanceDB（双库架构）

| 数据库 | 用途 | 选型理由 |
|--------|------|----------|
| **SQLite (better-sqlite3)** | 关系型元数据 | Meeting 已验证，WAL 模式性能优秀，零配置 |
| **LanceDB** | 向量 + 多模态 + 全文检索 | 唯一支持嵌入式零服务的多模态向量库，Node.js 原生绑定 |

**为什么不用 Qdrant/Chroma？**
- Qdrant：虽然性能优秀（Rust 编写），但必须启动服务进程（`qdrant` 二进制或 Docker），增加部署复杂度
- Chroma：Node.js 客户端不如 Python 成熟，且其架构偏向 client-server，嵌入式模式是"兼容特性"而非设计目标
- LanceDB：设计之初就是**嵌入式优先**，Node.js 是官方一级支持语言

**为什么不用 Meilisearch/Typesense？**
- 两者都是独立搜索引擎进程，需要额外维护
- LanceDB 已内置基于 Tantivy 的全文搜索，对于个人桌面场景足够

#### AI / 嵌入模型层：ONNX Runtime（本地 CPU）

| 模型 | 用途 | 来源 | 大小 | 运行方式 |
|------|------|------|------|----------|
| **CLIP-ViT-B-32 (ONNX)** | 图片/文本对齐向量 | OpenAI CLIP 转 ONNX | ~300MB | onnxruntime-node |
| **BGE-small-zh-v1.5 (ONNX)** | 中文文本语义嵌入 | BAAI 转 ONNX | ~100MB | onnxruntime-node |
| **PaddleOCR (ONNX)** | 图片 OCR 提取文字 | Paddle 官方 ONNX | ~40MB | onnxruntime-node |

> 决策理由：与 Meeting 的 sherpa-onnx-node 完全一致——首次使用时下载模型，之后完全离线。CPU 即可运行（M 系列芯片速度优秀）。

**备选：Python 子进程方案**
- 如果 Node.js 的 ONNX Runtime 在多模态推理上受限，可以封装一个轻量的 Python 子进程（`transformers` + `onnxruntime`）
- 主进程通过 stdio/IPC 与 Python 子进程通信
- 参考 khoj 的做法，但 khoj 是主方案用 Python，我们把它降级为备选

#### 文件监控与处理层

| 组件 | 用途 | 选型 |
|------|------|------|
| **chokidar** | 文件系统监控 | Node.js 业界标准 |
| **sharp** | 图片处理、缩略图生成 | 性能优秀，原生模块 |
| **exifr** | EXIF 元数据提取 | 轻量纯 JS |
| **pdf-parse** | PDF 文本提取 | 够用 |
| **mammoth** | Word 文档转纯文本 | 轻量 |
| **fast-xml-parser** | RSS/XML 解析 | 快速 |
| **cheerio** | HTML 解析（爬虫） | 轻量类 jQuery API |

#### 第三方平台集成层

| 平台 | 技术方案 | 复杂度 |
|------|----------|--------|
| **小红书** | Playwright / 分享链接逆向解析 | 中高 |
| **抖音** | 分享链接 API 解析 / 收藏页爬虫 | 中 |
| **微信公众号** | 收藏页导出 / 历史文章爬虫 | 中 |
| **CSDN** | RSS + 收藏 API | 低 |
| **RSS/Newsletter** | RSS 拉取 + IMAP 邮件解析 | 低 |

> 所有平台集成统一抽象为**插件接口**，每个插件返回标准化内容模型。

---

## 三、架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                      Electron 主进程                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ 文件监控引擎  │  │ 内容解析管线  │  │ 平台同步调度器    │   │
│  │ (chokidar)   │  │ (OCR/嵌入)   │  │ (插件系统)        │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         │                 │                    │             │
│  ┌──────▼─────────────────▼────────────────────▼─────────┐   │
│  │              统一内容模型 (Unified Content)             │   │
│  │   {id, type, title, content, media, vectors, meta}    │   │
│  └──────┬─────────────────┬─────────────────────┬─────────┘   │
│         │                 │                     │             │
│  ┌──────▼──────┐   ┌──────▼──────┐      ┌──────▼──────┐      │
│  │  SQLite     │   │  LanceDB    │      │  本地文件   │      │
│  │ (元数据)    │   │ (向量+全文) │      │ (原始媒体)  │      │
│  └─────────────┘   └─────────────┘      └─────────────┘      │
│                                                              │
└──────────────────────────┬───────────────────────────────────┘
                           │ IPC
┌──────────────────────────▼───────────────────────────────────┐
│                     Electron 渲染进程                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ 文件浏览视图  │  │ 统一搜索界面  │  │ 时间线/订阅视图   │   │
│  │ (网格/列表)  │  │ (文搜文/图搜) │  │ (RSS/平台内容)   │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
│                                                              │
│  React 19 + zustand + 纯 CSS (沿用 Meeting 设计体系)         │
└─────────────────────────────────────────────────────────────┘
```

---

## 四、与 Oasis Meeting 的复用策略

### 4.1 直接复用的资产

| 资产 | 复用方式 |
|------|----------|
| CSS 设计变量系统 | 复制 `styles.css` 变量根，按需扩展 |
| 字体/品牌资源 | 直接复用 BrandDisplay / OasisWordmark |
| 主题切换逻辑 | 复用 `uiStore` 的 theme toggle |
| IPC 通信模式 | 复用 `shared/ipc.ts` 的通道定义模式 |
| better-sqlite3 封装 | 复用 `db.ts` 的 WAL + prepared statement 模式 |
| 构建配置 | 复用 `electron.vite.config.ts` + `electron-builder.yml` |
| 快捷键体系 | 复用 ⌘K 搜索等全局快捷键模式 |

### 4.2 需要新建的部分

- **图片网格/瀑布流组件**：Meeting 没有大量图片展示场景
- **向量检索结果页**：需要展示图片缩略图 + 文本片段 + 相关性分数
- **文件详情页**：EXIF 展示、图片预览、OCR 文本侧栏
- **平台认证/同步设置页**：各平台的登录态管理
- **插件系统**：统一的 PlatformPlugin 基类 + 注册机制

---

## 五、风险与备选方案

| 风险点 | 影响 | 缓解措施 |
|--------|------|----------|
| LanceDB Node.js 绑定在 Electron 环境编译失败 | 高 | 提前验证 `npm install @lancedb/lancedb` 在 Electron 下是否可用；备选：Qdrant 嵌入式模式 |
| ONNX 模型过大（CLIP 300MB）导致首次下载体验差 | 中 | 支持模型选择（小模型优先下载）；增量下载；显示进度 |
| 小红书/抖音等平台反爬升级 | 中 | 插件化设计，单个平台失效不影响整体；提供手动导入作为兜底 |
| 大量图片索引时内存占用过高 | 中 | 批量处理 + 限制并发；缩略图与原始图分离存储；虚拟滚动 |
| 文件监控遗漏或误报 | 低 | chokidar + 定期全量扫描兜底；哈希去重 |

---

## 六、推荐的首期技术栈

```
桌面框架：    Electron 43 + electron-vite 5 + React 19 + TypeScript
UI 状态：     zustand
样式：        纯 CSS 变量（复用 Meeting 暖纸墨体系）
关系数据：    better-sqlite3 (WAL)
向量/全文：   LanceDB (@lancedb/lancedb Node.js 绑定)
文件监控：    chokidar
图片处理：    sharp
嵌入模型：    onnxruntime-node + CLIP/BGE ONNX
OCR：         PaddleOCR ONNX / RapidOCR
内容解析：    pdf-parse, mammoth, cheerio
平台集成：    Playwright (爬虫) + 分享链接解析
构建：        electron-builder (复用 Meeting 配置)
```
