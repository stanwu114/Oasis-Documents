# Oasis Documents

本地优先的个人数字资产中枢：**整理 · 检索 · 收藏 · 订阅**。除在线模型调用（可选）外，所有数据与推理都在你的电脑上完成。

## 功能

| 模块 | 能力 |
| --- | --- |
| **我的文件** | 监控目录自动索引；六分类（图片/视频/图纸/音频/文档/其他）；图片缩略图、视频抽帧、文档全文 |
| **文件检索** | FTS5 中文全文（bigram）+ BGE 语义（以文搜文）+ CLIP 图文（以文搜图/以图搜图）+ Vision OCR（图中文字可搜） |
| **文件整理** | SHA-256 精确去重 + pHash 近似图片；结构化规则归档（建议→审阅→执行→可撤销） |
| **平台收藏** | 小红书/抖音/公众号/CSDN 分享文案粘贴导入（自动提取链接）；AI 打标（在线 LLM 优先，本地关键短语兜底）；小红书式瀑布流 |
| **新闻订阅** | RSS/Atom 订阅时间线（已读/星标）；纯净阅读 + 划线笔记；定时刷新（失败退避） |
| **阅读与笔记** | 收藏/订阅正文纯净阅读；划线高亮 + 笔记关联资产 |
| **数据** | 浏览器书签 HTML / OPML / JSON 导入导出 |

## 能力矩阵与已知限制

| 能力 | 状态 |
| --- | --- |
| 本地嵌入（BGE-small-zh + CLIP ViT-B/32，ONNX CPU） | ✅ |
| 在线嵌入 / LLM 打标（OpenAI 兼容：智谱/通义/自定义） | ✅ 可选 |
| OCR（macOS Vision，中文+HEIC） | ✅ macOS |
| 视频语义检索（SentrySearch sidecar） | 🔖 架构预留，未启用 |
| .doc/.ppt/.xlsx 等旧版二进制 Office 全文 | ⛔ 元数据入库，标"暂不支持全文" |
| 安装包签名/公证 | ⛔ 需 Apple Developer 证书 |
| Windows / Linux | ⛔ 未验证（OCR/HEIC 依赖 macOS） |

## 开发

```bash
npm install        # postinstall 会为 Electron 重编译 better-sqlite3
npm run dev        # 开发模式
npm run typecheck  # 类型检查
npm test           # 回归测试（node:test，零依赖）
npm run build      # 生产构建
npm run dist       # 打包 macOS arm64 DMG/ZIP
node scripts/perf-baseline.mjs   # 性能基线实测 → docs/PERF_BASELINE.md
```

## 技术栈

Electron 43（主进程集中式）+ React 19 + zustand · better-sqlite3（WAL + FTS5）· LanceDB（嵌入式向量，同表写互斥）· onnxruntime-node · sharp / ffmpeg-static / macOS Vision。

数据位置：`~/Library/Application Support/Oasis Documents/`（数据库 / 向量库 / 模型 / 缓存）。

## 文档

- [PRD](docs/PRD.md) · [架构](docs/ARCHITECTURE.md) · [技术调研](docs/TECH_RESEARCH.md) · [模型比较](docs/MODEL_COMPARISON.md)
- [整改与开发计划（已全部实施）](docs/REMEDIATION_AND_DEVELOPMENT_PLAN.md) · [性能基线](docs/PERF_BASELINE.md) · [视频检索设计（预留）](docs/VIDEO_SEARCH.md)

## License

MIT
