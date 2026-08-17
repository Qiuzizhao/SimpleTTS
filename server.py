# -*- coding: utf-8 -*-
"""
SimpleTTS 本地语音服务
- 托管前端页面（index.html / style.css / app.js / phrases.js）
- GET  /api/tts      文字转语音（edge-tts，MP3，流式 + 磁盘/内存缓存）
- GET  /api/voices   可选中文音色列表
- GET  /api/phrases  读取常用短语（服务端持久化，多设备同步）
- PUT  /api/phrases  保存常用短语（整表替换，单用户场景足够）
- GET  /api/ping     健康检查（前端据此决定是否降级为浏览器语音）

数据目录 data/：语音缓存（data/cache）+ 短语（data/phrases.json），
Docker 部署时挂载该目录即可持久化。
"""
import asyncio
import hashlib
import json
import os
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
CACHE_DIR = DATA_DIR / "cache"
PHRASES_FILE = DATA_DIR / "phrases.json"
DATA_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(exist_ok=True)

try:
    import edge_tts
except ImportError:
    print("缺少依赖 edge-tts，请先运行: pip install -r requirements.txt", file=sys.stderr)
    sys.exit(1)

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))

DEFAULT_VOICE = "zh-CN-XiaoyiNeural"
MAX_TEXT = 500
CACHE_LIMIT = 256
MAX_PHRASES = 200

# 内存缓存: sha256(voice|rate|volume|text) -> mp3 bytes
_cache: dict[str, bytes] = {}
# 浏览器缓存：同一 URL 由（文本+音色+语速+音量）决定，内容不变，可长期缓存
CACHE_HEADERS = {"Cache-Control": "public, max-age=31536000, immutable"}

_phrases_lock = asyncio.Lock()

app = FastAPI(title="SimpleTTS")


def _cache_key(text: str, voice: str, rate: str, volume: str) -> str:
    raw = f"{voice}|{rate}|{volume}|{text}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _cache_put(key: str, data: bytes) -> None:
    if len(_cache) >= CACHE_LIMIT:
        _cache.pop(next(iter(_cache)))
    _cache[key] = data


def _trim_cache_dir(limit_bytes: int = 200 * 1024 * 1024) -> None:
    """磁盘缓存超过上限时整体清空（单个 MP3 很小，清空后按需重建）"""
    total = sum(f.stat().st_size for f in CACHE_DIR.glob("*.mp3"))
    if total > limit_bytes:
        for f in CACHE_DIR.glob("*.mp3"):
            try:
                f.unlink()
            except OSError:
                pass


def _load_phrases() -> list[str]:
    try:
        data = json.loads(PHRASES_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    seen: list[str] = []
    for item in data:
        s = str(item).strip() if item is not None else ""
        if s and s not in seen:
            seen.append(s)
    return seen


async def _save_phrases(phrases: list[str]) -> None:
    async with _phrases_lock:
        PHRASES_FILE.write_text(
            json.dumps(phrases, ensure_ascii=False, indent=2), encoding="utf-8"
        )


@app.get("/api/ping")
async def ping():
    return {"ok": True, "voice": DEFAULT_VOICE}


@app.get("/api/voices")
async def list_voices():
    return {
        "default": DEFAULT_VOICE,
        "list": [
            {"id": "zh-CN-XiaoyiNeural", "name": "晓伊（女声 · 推荐）"},
            {"id": "zh-CN-XiaoxiaoNeural", "name": "晓晓（女声）"},
            {"id": "zh-CN-YunxiNeural", "name": "云希（男声）"},
            {"id": "zh-CN-XiaoyiNeural", "name": "晓伊（女声）"},
            {"id": "zh-CN-YunjianNeural", "name": "云健（男声）"},
            {"id": "zh-CN-YunyangNeural", "name": "云扬（男声）"},
            {"id": "zh-CN-YunxiaNeural", "name": "云夏（少年音）"},
        ],
    }


@app.get("/api/phrases")
async def get_phrases():
    return {"phrases": _load_phrases()}


@app.put("/api/phrases")
async def put_phrases(payload: dict):
    raw = payload.get("phrases")
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail="phrases 必须是数组")
    if len(raw) > MAX_PHRASES:
        raise HTTPException(status_code=400, detail=f"短语数量过多（最多 {MAX_PHRASES} 条）")
    cleaned: list[str] = []
    for item in raw:
        s = str(item).strip() if item is not None else ""
        if s and s not in cleaned:
            cleaned.append(s)
    await _save_phrases(cleaned)
    return {"ok": True, "count": len(cleaned)}


@app.get("/api/tts")
async def tts(text: str, voice: str = DEFAULT_VOICE, rate: str = "+0%", volume: str = "+0%"):
    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="文本不能为空")
    if len(text) > MAX_TEXT:
        raise HTTPException(status_code=400, detail=f"文本过长（最多 {MAX_TEXT} 字）")

    key = _cache_key(text, voice, rate, volume)
    fpath = CACHE_DIR / f"{key}.mp3"

    if key in _cache:
        return Response(content=_cache[key], media_type="audio/mpeg", headers=CACHE_HEADERS)
    if fpath.exists():
        data = fpath.read_bytes()
        _cache_put(key, data)
        return Response(content=data, media_type="audio/mpeg", headers=CACHE_HEADERS)

    async def gen():
        # 边合成边输出（首字延迟更低）；同时累积完整音频用于缓存
        buffer = bytearray()
        try:
            communicate = edge_tts.Communicate(
                text,
                voice=voice,
                rate=rate,
                volume=volume,
                connect_timeout=5,
                receive_timeout=15,
            )
            async for chunk in communicate.stream():
                if chunk.get("type") == "audio":
                    buffer.extend(chunk["data"])
                    yield chunk["data"]
        except Exception:
            # 网络失败/音色无效：中断流，浏览器 Audio 触发 error → 前端自动降级
            if not buffer:
                raise
            return
        if buffer:
            data = bytes(buffer)
            try:
                fpath.write_bytes(data)
            except OSError:
                pass  # 磁盘写入失败不影响本次播放
            _cache_put(key, data)

    return StreamingResponse(gen(), media_type="audio/mpeg", headers=CACHE_HEADERS)


# 静态页面最后挂载，保证 /api/* 路由优先匹配
app.mount("/", StaticFiles(directory=str(BASE_DIR), html=True), name="static")


def main():
    import uvicorn

    _trim_cache_dir()
    print("=" * 46)
    print("  SimpleTTS 语音服务")
    print(f"  本机访问: http://localhost:{PORT}")
    if HOST != "127.0.0.1":
        import socket
        try:
            ip = socket.gethostbyname(socket.gethostname())
            print(f"  局域网访问: http://{ip}:{PORT}（如被拦截请放行防火墙）")
        except Exception:
            pass
    print(f"  数据目录: {DATA_DIR}（语音缓存 + 短语）")
    print("  按 Ctrl+C 停止")
    print("=" * 46)
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
