"""Breeze-ASR-25 轉錄核心：模型載入與長音檔轉錄（純函式，便於單獨測試）。

裝置自動偵測：有 CUDA → fp16/bf16 GPU 推理；否則 CPU float32（慢，
一小時會議可能要轉數十分鐘——本服務是非同步 job 模式，慢不阻塞呼叫端）。
"""

import logging
import os

logger = logging.getLogger("whisper-service")

MODEL_ID = os.environ.get("WHISPER_MODEL_ID", "MediaTek-Research/Breeze-ASR-25")

_pipeline = None  # lazy singleton：首次轉錄才載入（~3GB 權重，下載+載入需時）


def get_device_info() -> dict:
    import torch

    if torch.cuda.is_available():
        return {"device": "cuda", "name": torch.cuda.get_device_name(0)}
    return {"device": "cpu", "name": "cpu"}


def _load_pipeline():
    global _pipeline
    if _pipeline is not None:
        return _pipeline

    import torch
    from transformers import pipeline

    if torch.cuda.is_available():
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        device = "cuda:0"
    else:
        dtype = torch.float32
        device = "cpu"

    logger.info("loading model %s on %s (%s)", MODEL_ID, device, dtype)
    _pipeline = pipeline(
        "automatic-speech-recognition",
        model=MODEL_ID,
        torch_dtype=dtype,
        device=device,
        # Whisper 原生 30 秒窗；chunked long-form 讓任意長度音檔可轉，
        # 並帶回每個 chunk 的時間戳供逐字稿對時。
        chunk_length_s=30,
        return_timestamps=True,
    )
    return _pipeline


def transcribe_file(audio_path: str) -> list[dict]:
    """轉錄音檔，回傳 [{text, start, end}]（秒，浮點）。

    chunk 的 timestamp 可能是 None（模型偶發），此時沿用前一段的 end 遞補，
    確保輸出永遠是單調遞增的合法時間軸。
    """
    pipe = _load_pipeline()
    result = pipe(audio_path)

    chunks = result.get("chunks") or []
    if not chunks and result.get("text"):
        # 短音檔可能不回 chunks，整段當一個 segment
        return [{"text": result["text"].strip(), "start": 0.0, "end": 0.0}]

    segments: list[dict] = []
    prev_end = 0.0
    for chunk in chunks:
        text = (chunk.get("text") or "").strip()
        if not text:
            continue
        ts = chunk.get("timestamp") or (None, None)
        start = ts[0] if ts[0] is not None else prev_end
        end = ts[1] if ts[1] is not None else start
        prev_end = end
        segments.append({"text": text, "start": float(start), "end": float(end)})
    return segments
