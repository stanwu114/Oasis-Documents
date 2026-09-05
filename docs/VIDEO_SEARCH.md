# 视频检索集成设计 — 基于 SentrySearch

> **状态：本期范围外，架构预留。** sidecar 代码（`src/main/video/`、`resources/video-sidecar/bridge.py`）已就绪但不在本期交付内，不阻塞主流程（仅用户主动触发 `video:init` 才会拉起 Python）。开启条件：用户决定使用 DashScope 云端后端（需 API Key）或本地后端（需 ≥16GB 统一内存）。

## 一、SentrySearch 技术画像（调研结论）

仓库：[ssrajadh/sentrysearch](https://github.com/ssrajadh/sentrysearch)（Apache-2.0，Python 3.11/3.12）
派生：[jakejimenez/sentinelsearch](https://github.com/jakejimenez/sentinelsearch)（MIT，简化版，本地 8B 专用）

### 1.1 核心管线

```
视频文件 → ffmpeg 切块(30s块+5s重叠, -c copy 流复制)
        → 预处理(480px/5fps/CRF28, 可选)
        → 静止检测(3帧JPEG大小对比, min/max≥0.98 跳过)
        → 嵌入(视频块原生投影到与文本同一向量空间, 无转录无帧描述)
        → ChromaDB 存储(cosine, chunk_id=sha256(file:start)[:16], 支持断点续传)
        → 文本查询嵌入 → 余弦检索 → 自动裁剪片段返回
```

**为什么原生视频嵌入是关键**：传统方案是"抽帧→描述→文本嵌入"（信息损失大）或"抽帧→CLIP逐帧→池化"（丢失时序）。SentrySearch 用 Qwen3-VL-Embedding 把视频帧直接投影到文本同一空间，"红色卡车闯红灯"这类查询能命中运动过程。

### 1.2 三后端对比（与本项目「本地+在线双模式」天然对齐）

| 后端 | 模型 | 视频输入 | 维度 | Python 依赖重量 | 门槛 |
|---|---|---|---|---|---|
| **qwen-cloud** | qwen3-vl-embedding (DashScope) | SDK 自动上传临时 OSS，fps=0.5 | 768 | 轻（dashscope SDK，无 torch） | API Key，45 RPM 限流 |
| **gemini** | gemini-embedding (google-genai) | 见其 embedder | 768 | 轻（google-genai，无 torch） | API Key，需海外网络 |
| **local** | Qwen3-VL-Embedding 2B/8B | 1fps 抽帧最多 32 帧，直接进模型 | 768（MRL 截断+重归一化） | 重（torch+transformers，8B 模型 18GB） | MPS≥24GB 选 8B，16GB 选 2B；CPU 不可用 |

**关键洞察**：
- 云端后端（qwen-cloud）**不需要 torch**，Python 环境只有 ~200MB — 可以作为默认分发模式
- 本地后端按需安装 `[local]` extra（数 GB），设置页检测统一内存后推荐
- MRL 截断到 768 维后重 L2 归一化 — 与我们 LanceDB 侧的向量管理逻辑兼容
- DashScope 传视频：直接给本地路径，SDK 自动代传 OSS，无需自建存储

### 1.3 库层 API（bridge 依赖的稳定接口）

```python
# chunker
chunk_video(path, chunk_duration=30, overlap=5) -> list[(start, end)]
preprocess_chunk(path, target_resolution=480, target_fps=5) -> str
is_still_frame_chunk(path, threshold=0.98) -> bool

# base_embedder（三个后端都实现）
embed_video_chunk(chunk_path) -> list[float]
embed_query(query_text) -> list[float]
embed_image(image_path) -> list[float]
dimensions() -> int

# store (ChromaDB 封装)
add_chunks(chunks)                    # upsert, chunk_id 自动生成
search(query_embedding, n_results=5) -> [{source_file, start_time, end_time, score}]
is_indexed(source_file) -> bool       # 断点续传
remove_file(source_file) -> int
get_stats() -> dict

# 集合按后端隔离: dashcam_chunks_qwen_cloud_<model> / _local_<model>
```

---

## 二、集成架构

### 2.1 总体拓扑

```
┌────────────────────────────────────────────────────────────┐
│ Electron 主进程 (Node.js)                                    │
│                                                              │
│  src/main/video/sidecar.ts   ←→  渲染进程 (IPC video:*)      │
│    · spawn/重启 python bridge                                │
│    · stdio JSON-RPC（每行一个 JSON）                          │
│    · 进度事件转发                                             │
└──────────────┬───────────────────────────────────────────────┘
               │ stdin/stdout (line-delimited JSON)
┌──────────────▼───────────────────────────────────────────────┐
│ Python Sidecar  resources/video-sidecar/bridge.py            │
│  · import sentrysearch（用户环境 venv 或打包内置）              │
│  · init / index / search / stats / remove / reset             │
│  · progress 事件推送                                          │
│    ├─ qwen-cloud: dashscope SDK（轻依赖）                      │
│    ├─ gemini: google-genai SDK（轻依赖）                       │
│    └─ local: torch + transformers（重依赖，按需安装）           │
│                                                              │
│  ChromaDB 存储: ~/Library/Application Support/Oasis Documents/│
│                 video-index/chroma/ （sidecar 私有）           │
└──────────────────────────────────────────────────────────────┘
```

**存储策略**：视频向量留在 sidecar 私有的 ChromaDB 里，主应用不直接读它。检索时主应用调 sidecar 拿 `{video_path, start, end, score}`，再通过 video_path 关联 `contents` 表补全标题/缩略图/平台信息。这样 SentrySearch 升级不影响主库，主库 LanceDB 也不需要管 4096/768 维异构向量。

### 2.2 JSON-RPC 协议

主 → sidecar（stdin，每行一个请求）：
```json
{"id":1,"method":"init","params":{"backend":"qwen-cloud","api_key":"...","db_path":"..."}}
{"id":2,"method":"index","params":{"paths":["/a.mp4"],"chunk_duration":30,"overlap":5,"skip_still":true}}
{"id":3,"method":"search","params":{"query":"红色卡车","limit":10}}
{"id":4,"method":"stats","params":{}}
{"id":5,"method":"remove","params":{"source_file":"/a.mp4"}}
```

sidecar → 主（stdout，每行一个响应或事件）：
```json
{"id":1,"result":{"ok":true,"backend":"qwen-cloud","dimensions":768}}
{"event":"progress","data":{"file":"/a.mp4","chunk":5,"total_chunks":20,"still_skipped":2}}
{"id":2,"result":{"indexed_chunks":18,"skipped_still":2,"errors":[]}}
{"id":3,"result":{"results":[{"source_file":"/a.mp4","start":135.0,"end":165.0,"score":0.87}]}}
```

stderr → 日志文件（调试用，不进协议）。

### 2.3 Python 环境管理

| 模式 | 环境 | 体积 | 适用 |
|---|---|---|---|
| 云端（默认） | 打包内置 venv（dashscope/chromadb，无 torch） | ~250MB | 所有用户 |
| 本地 heavy | 首次使用时 `pip install sentrysearch[local]` 到扩展 venv | 4-6GB（含模型另计） | ≥16GB 统一内存的 Mac |

检测顺序：bundled venv → 用户 PATH python3 → 设置页引导。

### 2.4 与统一检索的融合

- `search:query` 结果合并：视频结果显示为「视频卡片」（封面帧 + 命中时间段 + 分数）
- 点击卡片：渲染进程 `<video src="file://...#t=start,end">` 直接定位播放片段
- 视频索引状态在「整理工作台」展示（索引慢：本地 8B 约 1 小时素材 15-25 分钟；云端受 45 RPM 限流）

---

## 三、风险与对策

| 风险 | 对策 |
|---|---|
| sentrysearch 库 API 变动（项目活跃迭代） | bridge.py 只依赖 base_embedder/chunker/store 三个稳定模块；锁定版本安装 |
| DashScope 限流（45 RPM） | bridge 内置滑动窗口限流 + 指数退避（继承自 qwen_cloud_embedder） |
| 本地后端内存不足 | init 时检测统一内存，<16GB 禁选 local，引导云端 |
| 视频格式仅 .mp4 | 入库时用 ffmpeg 转封装（`-c copy` 到 mp4 容器，不重编码） |
| 索引中断 | chunk_id 确定性生成 + is_indexed 断点续传（已内建） |
| 首次下载 8B 模型 18GB | 明确提示体积与耗时，默认云端 |

---

## 四、里程碑调整（视频检索提前）

原 Phase 4 的「视频关键帧索引」升级为独立模块，并入 Phase 2：

- **Phase 2a**：sidecar 骨架 + qwen-cloud 后端 + 视频卡片搜索结果（**云端模式优先，免重依赖**）
- **Phase 2b**：本地后端接入（设置页硬件检测 + 模型下载引导）
- **Phase 2c**：以图搜视频（embed_image 已在接口里）、Gemini 后端、片段裁剪导出
