#!/usr/bin/env python3
"""Oasis Documents 视频检索 sidecar — SentrySearch 桥接。

协议: 每行一个 JSON 于 stdin/stdout。
  请求: {"id": int, "method": str, "params": dict}
  响应: {"id": int, "result": ...} 或 {"id": int, "error": str}
  事件: {"event": "progress"|"log", "data": {...}}

用法: python bridge.py [--db-path DIR]
依赖: pip install sentrysearch[qwen-cloud] 或 sentrysearch[local]
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
import traceback
from pathlib import Path


def log(msg: str) -> None:
    """stderr 日志（不污染 stdout 协议通道）。"""
    print(f"[bridge] {msg}", file=sys.stderr, flush=True)


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def emit_event(name: str, data: dict) -> None:
    emit({"event": name, "data": data})


# ------------------------------------------------------------------
# SentrySearch 组件加载（对类名变动做防御性探测）
# ------------------------------------------------------------------

def _first_attr(module, names: list[str]):
    for n in names:
        if hasattr(module, n):
            return getattr(module, n)
    raise RuntimeError(
        f"module {module.__name__} 缺少 {'/'.join(names)}; "
        f"可用: {[n for n in dir(module) if not n.startswith('_')]}"
    )


class Bridge:
    def __init__(self, db_path: str | None):
        self.db_path = db_path
        self.chunker = None
        self.store_cls = None
        self.embedder = None
        self.backend: str | None = None
        self.ready = False

    # ---- 组件懒加载 ----

    def _load_core(self):
        if self.chunker is None:
            self.chunker = importlib.import_module("sentrysearch.chunker")
        if self.store_cls is None:
            store_mod = importlib.import_module("sentrysearch.store")
            self.store_cls = _first_attr(store_mod, ["ChunkStore", "VectorStore", "Store"])

    def _make_embedder(self, backend: str, api_key: str | None, model: str | None):
        if backend == "qwen-cloud":
            mod = importlib.import_module("sentrysearch.qwen_cloud_embedder")
            cls = _first_attr(mod, ["QwenCloudEmbedder", "DashScopeEmbedder", "QwenCloudEmbedderClient"])
            kwargs = {}
            if api_key:
                kwargs["api_key"] = api_key
            if model:
                kwargs["model"] = model
            return cls(**kwargs)
        if backend == "gemini":
            mod = importlib.import_module("sentrysearch.gemini_embedder")
            cls = _first_attr(mod, ["GeminiEmbedder", "GeminiEmbedderClient"])
            kwargs = {}
            if api_key:
                kwargs["api_key"] = api_key
            if model:
                kwargs["model"] = model
            return cls(**kwargs)
        if backend == "local":
            mod = importlib.import_module("sentrysearch.local_embedder")
            cls = _first_attr(mod, ["LocalEmbedder", "QwenLocalEmbedder", "LocalQwenEmbedder"])
            kwargs = {"dimensions": 768}
            if model:
                kwargs["model_name"] = kwargs.get("model_name", model)
            return cls(**kwargs)
        raise ValueError(f"未知后端: {backend}（可选 qwen-cloud / gemini / local）")

    # ---- RPC 方法 ----

    def rpc_init(self, params: dict):
        backend = params.get("backend", "qwen-cloud")
        api_key = params.get("api_key")
        model = params.get("model")
        db_path = params.get("db_path") or self.db_path

        self._load_core()
        self.embedder = self._make_embedder(backend, api_key, model)
        self.store = self.store_cls(db_path=db_path, backend=backend, model=model)
        self.backend = backend
        self.ready = True

        return {
            "ok": True,
            "backend": backend,
            "dimensions": self.embedder.dimensions(),
        }

    def rpc_index(self, params: dict):
        self._require_ready()
        paths = [Path(p) for p in params.get("paths", [])]
        chunk_duration = int(params.get("chunk_duration", 30))
        overlap = int(params.get("overlap", 5))
        skip_still = bool(params.get("skip_still", True))

        total_chunks = 0
        skipped_still = 0
        errors: list[dict] = []

        for path in paths:
            try:
                if self.store.is_indexed(str(path)):
                    emit_event("progress", {"file": str(path), "skip": "already-indexed"})
                    continue

                spans = self.chunker.chunk_video(str(path), chunk_duration=chunk_duration, overlap=overlap)
                duration = self.chunker.get_duration(str(path)) if hasattr(self.chunker, "get_duration") else None

                for i, (start, end) in enumerate(spans):
                    emit_event("progress", {"file": str(path), "chunk": i + 1, "total_chunks": len(spans)})

                    chunk_path = self.chunker.extract_chunk(str(path), start, end) if hasattr(
                        self.chunker, "extract_chunk"
                    ) else self._extract_chunk_fallback(str(path), start, end)

                    if skip_still and self.chunker.is_still_frame_chunk(chunk_path):
                        skipped_still += 1
                        self._cleanup(chunk_path)
                        continue

                    embedding = self.embedder.embed_video_chunk(chunk_path)
                    self.store.add_chunk(
                        chunk_id=self._chunk_id(str(path), start),
                        embedding=embedding,
                        metadata={
                            "source_file": str(path),
                            "start_time": float(start),
                            "end_time": float(end),
                            "duration": duration or (end - start),
                        },
                    )
                    total_chunks += 1
                    self._cleanup(chunk_path)
            except Exception as e:  # noqa: BLE001 — 单文件失败不中断批次
                errors.append({"file": str(path), "error": str(e)})
                log(f"index error {path}: {e}\n{traceback.format_exc()}")

        return {"indexed_chunks": total_chunks, "skipped_still": skipped_still, "errors": errors}

    def rpc_search(self, params: dict):
        self._require_ready()
        query = params.get("query", "")
        limit = int(params.get("limit", 10))
        if not query.strip():
            return {"results": []}

        embedding = self.embedder.embed_query(query)
        hits = self.store.search(embedding, n_results=limit)
        return {"results": hits}

    def rpc_stats(self, _params: dict):
        self._require_ready()
        return self.store.get_stats()

    def rpc_remove(self, params: dict):
        self._require_ready()
        removed = self.store.remove_file(params["source_file"])
        return {"removed": removed}

    def rpc_ping(self, _params: dict):
        return {"ok": True, "backend": self.backend}

    # ---- 工具 ----

    def _require_ready(self):
        if not self.ready:
            raise RuntimeError("未 init：请先调用 init(backend, ...)")

    def _chunk_id(self, source: str, start: float) -> str:
        import hashlib

        return hashlib.sha256(f"{source}:{start}".encode()).hexdigest()[:16]

    def _extract_chunk_fallback(self, video: str, start: float, end: float) -> str:
        """chunker 无 extract_chunk 时的兜底：ffmpeg -c copy 快切。"""
        import subprocess
        import tempfile

        out = tempfile.mktemp(suffix=".mp4")
        subprocess.run(
            ["ffmpeg", "-y", "-ss", str(start), "-i", video, "-t", str(end - start), "-c", "copy", out],
            check=True,
            capture_output=True,
        )
        return out

    def _cleanup(self, path: str) -> None:
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            pass


METHODS = {
    "init": Bridge.rpc_init,
    "index": Bridge.rpc_index,
    "search": Bridge.rpc_search,
    "stats": Bridge.rpc_stats,
    "remove": Bridge.rpc_remove,
    "ping": Bridge.rpc_ping,
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", default=None)
    args = parser.parse_args()

    bridge = Bridge(args.db_path)
    emit_event("log", {"msg": "bridge-ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            method = req.get("method")
            handler = METHODS.get(method)
            if handler is None:
                emit({"id": req_id, "error": f"未知方法: {method}"})
                continue
            result = handler(bridge, req.get("params") or {})
            emit({"id": req_id, "result": result})
        except Exception as e:  # noqa: BLE001
            log(traceback.format_exc())
            emit({"id": req_id, "error": str(e)})


if __name__ == "__main__":
    main()
