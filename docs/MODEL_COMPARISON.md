# 嵌入模型对比：Qwen3-VL-Embedding vs CLIP/BGE

## 一、关于 "SentrySearch"

**重要澄清**：SentrySearch / SentinelSearch **不是**一个成熟的框架或产品。

- [ssrajadh/sentrysearch](https://github.com/ssrajadh/sentrysearch) — 个人项目："Semantic search over videos using Gemini Embedding 2 or Qwen3-VL"
- [jakejimenez/sentinelsearch](https://github.com/jakejimenez/sentinelsearch) — 个人项目："Semantic search over video footage using Qwen3-VL-Embedding-8B"

它们本质上是开发者基于 Qwen3-VL-Embedding 搭建的**视频语义搜索 demo**，技术栈为 Python + PyTorch + ChromaDB + ffmpeg。没有可复用的 SDK 或框架，也没有 Electron/Node.js 生态的支持。

---

## 二、Qwen3-VL-Embedding 模型详解

### 2.1 基本信息

| 属性 | Qwen3-VL-Embedding-2B | Qwen3-VL-Embedding-8B |
|------|----------------------|----------------------|
| **参数量** | 2B | 8B |
| **下载大小** | ~4 GB | ~16 GB |
| **推理显存** | ~4-6 GB VRAM | ~18 GB（全精度）/ ~6-8 GB（4-bit 量化） |
| **向量维度** | 4096（支持 MRL 截断至 768） | 4096（支持 MRL 截断至 768） |
| **运行方式** | PyTorch / transformers / vLLM | PyTorch / transformers / vLLM |
| **ONNX 支持** | ❌ 无（GitHub 搜索 0 结果） | ❌ 无 |
| **CPU 运行** | ⚠️ 支持 fallback，但 "too slow for practical use" | ❌ 不可行 |
| **推荐硬件** | Apple Silicon 16GB+ / NVIDIA GPU | Apple M4 Max 64GB / 24GB+ VRAM |

### 2.2 性能定位

Qwen3-VL-Embedding 是目前开源领域**最强的多模态嵌入模型之一**，官方宣称 "one of the most capable open multimodal embedding models available"。

优势：
- 图文对齐质量远超 CLIP（尤其是中文场景、复杂语义、细节理解）
- 支持 MRL（Matryoshka Representation Learning），可灵活截断向量维度
- 原生支持长文本 + 高分辨率图像

劣势（对桌面应用而言）：
- **体积巨大**：2B 是 CLIP 的 13 倍，8B 是 53 倍
- **必须 GPU**：官方明确指出 CPU-only "too slow for practical use"
- **无 ONNX 生态**：需要完整的 PyTorch 运行时，无法像 sherpa-onnx 那样轻量嵌入
- **打破架构**：如果采用它，必须引入 Python 子进程/服务，增加系统复杂度

---

## 三、CLIP + BGE 方案详解

### 3.1 CLIP（图文对齐）

| 属性 | CLIP ViT-B/32 (ONNX) |
|------|---------------------|
| **参数量** | ~150M |
| **ONNX 大小** | ~300 MB |
| **向量维度** | 512 |
| **运行方式** | onnxruntime-node（CPU 优先） |
| **CPU 性能** | ✅ M 系列芯片速度优秀，实时推理无压力 |
| **ONNX 生态** | ✅ 成熟，大量社区转换工具和预训练权重 |

### 3.2 BGE（中文文本语义）

| 属性 | BGE-small-zh-v1.5 (ONNX) |
|------|-------------------------|
| **参数量** | ~30M |
| **ONNX 大小** | ~100 MB |
| **向量维度** | 512 |
| **运行方式** | onnxruntime-node（CPU 优先） |
| **中文性能** | ✅ MTEB 中文榜单前列 |

### 3.3 组合方案总览

| 指标 | CLIP + BGE ONNX | Qwen3-VL-Embedding-2B |
|------|-----------------|----------------------|
| **总模型体积** | ~400 MB | ~4 GB |
| **内存/显存需求** | ~1 GB RAM（CPU） | ~4-6 GB VRAM（GPU 必须） |
| **首次下载体验** | ✅ 轻量，几分钟 | ⚠️ 4GB 下载，网络要求高 |
| **离线可用性** | ✅ 完全离线，零配置 | ✅ 完全离线，但需 PyTorch |
| **架构侵入性** | ✅ Node.js 原生，无额外进程 | ❌ 需 Python 子进程/服务 |
| **中文图文检索质量** | ⚠️ CLIP 中文一般，需 BGE 补充 | ✅ 顶尖水平 |
| **英文图文检索质量** | ✅ CLIP 原生优秀 | ✅ 顶尖水平 |
| **复杂语义理解** | ⚠️ 基础水平 | ✅ 强（得益于大参数） |
| **与 Meeting 技术一致性** | ✅ 完全一致的 ONNX 路线 | ❌ 完全不同的运行时 |

---

## 四、结论与建议

### 4.1 默认方案：CLIP + BGE ONNX（推荐）

**理由**：
1. **体积可控**：400MB 模型对个人桌面应用是合理负担（Meeting 的 SenseVoice 也是 240MB）
2. **CPU 友好**：完全不需要 GPU，M 系列 Mac 和主流 x86 CPU 都能流畅运行
3. **架构一致**：延续 Meeting 的 `onnxruntime-node` 路线，不需要引入 Python 运行时
4. **零服务进程**：不需要像 Qwen3-VL 那样维护一个 Python 推理子进程
5. **生态成熟**：ONNX 转换工具、预训练权重、社区方案都非常丰富

**对于中文场景的补偿**：
- CLIP 本身中文能力一般，但配合 BGE-small-zh（专门优化的中文嵌入模型）做文本侧，实际中文检索体验已经不错
- 图片 OCR（PaddleOCR）提取中文文本后也由 BGE 嵌入，进一步提升中文图搜效果

### 4.2 可选高级方案：Qwen3-VL-Embedding（未来扩展）

**作为设置中的可选"高性能模式"**：

```
设置 → 检索引擎 → 嵌入模型
├── [默认] 轻量模式 — CLIP + BGE ONNX (~400MB, CPU)
└── [可选] 高性能模式 — Qwen3-VL-Embedding-2B (~4GB, 需 GPU)
    ⚠️ 需要 Apple Silicon 16GB+ 或 NVIDIA GPU 4GB+ VRAM
```

**实现方式**：
- 检测到用户设备有 GPU 时，设置页显示该选项
- 通过 Python 子进程（`transformers` + `qwen-vl-utils`）运行 Qwen3-VL-Embedding
- 主进程通过 stdio/IPC 与子进程通信，进行批量嵌入推理
- 向量存储仍用 LanceDB，与默认方案完全兼容（只需保证向量维度一致，或通过 MRL 统一截断到 768 维）

**风险**：
- 增加约 200MB-300MB 的 Python 运行时 + 依赖包体积
- 子进程管理复杂度（启动、崩溃重启、版本兼容性）
- 首次模型下载 4GB，对网络条件差的用户不友好

### 4.3 最终决策

| 场景 | 推荐方案 |
|------|----------|
| **MVP 首发** | CLIP + BGE ONNX 唯一方案 |
| **后续版本（v1.5+）** | 增加 Qwen3-VL-Embedding 作为可选高性能模式 |
| **用户无 GPU** | 强制使用 CLIP + BGE |
| **用户有 Mac Studio / 游戏本** | 可选 Qwen3-VL，获得更好的图文对齐质量 |

**一句话总结**：Qwen3-VL-Embedding 是更强大的模型，但它对桌面应用的**体积、硬件要求、架构复杂度**的代价太高。CLIP + BGE ONNX 是当前阶段最务实的选择，Qwen3-VL 可作为未来升级路径保留。
