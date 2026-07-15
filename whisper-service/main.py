"""Whisper 轉錄微服務（Breeze-ASR-25）。

設計：job + polling。POST /jobs 收音檔 URL 立即回 job_id，單一 worker thread
序列化處理（GPU 一次只跑一個）；呼叫端（meetbot backend 的 retranscription-poller）
本來就是輪詢模式，直接輪 GET /jobs/{id} 拿結果。

Job store 是 in-memory：服務重啟 job 全失，呼叫端收 404 視為暫時失敗重送即可。
"""

import logging
import os
import queue
import tempfile
import threading
import uuid
from collections import OrderedDict

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import transcriber

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("whisper-service")

MAX_FINISHED_JOBS = 50  # 保留最近 N 筆完成/失敗的 job 結果，避免記憶體無限成長
DOWNLOAD_TIMEOUT_S = 300  # 錄音檔可能數百 MB

app = FastAPI(title="whisper-service")

_jobs: "OrderedDict[str, dict]" = OrderedDict()
_jobs_lock = threading.Lock()
_queue: "queue.Queue[str]" = queue.Queue()


class JobRequest(BaseModel):
    audio_url: str


def _prune_finished() -> None:
    """呼叫前須持有 _jobs_lock。"""
    finished = [jid for jid, j in _jobs.items() if j["status"] in ("done", "error")]
    while len(finished) > MAX_FINISHED_JOBS:
        _jobs.pop(finished.pop(0), None)


def _download_to_temp(url: str) -> str:
    """下載音檔到 temp 檔（副檔名交給 ffmpeg 嗅探，不依賴 URL）。"""
    fd, path = tempfile.mkstemp(prefix="whisper-audio-")
    try:
        with os.fdopen(fd, "wb") as f, httpx.stream(
            "GET", url, timeout=DOWNLOAD_TIMEOUT_S, follow_redirects=True
        ) as res:
            res.raise_for_status()
            for chunk in res.iter_bytes(1024 * 1024):
                f.write(chunk)
        return path
    except Exception:
        os.unlink(path)
        raise


def _worker() -> None:
    while True:
        job_id = _queue.get()
        with _jobs_lock:
            job = _jobs.get(job_id)
            if job is None:
                continue
            job["status"] = "processing"
        audio_path = None
        try:
            audio_path = _download_to_temp(job["audio_url"])
            segments = transcriber.transcribe_file(audio_path)
            with _jobs_lock:
                job["status"] = "done"
                job["segments"] = segments
                _prune_finished()
            logger.info("job %s done: %d segments", job_id, len(segments))
        except Exception as err:  # noqa: BLE001 — job 失敗不可拖垮 worker loop
            logger.exception("job %s failed", job_id)
            with _jobs_lock:
                job["status"] = "error"
                job["error"] = str(err)
                _prune_finished()
        finally:
            if audio_path:
                try:
                    os.unlink(audio_path)
                except OSError:
                    pass


threading.Thread(target=_worker, daemon=True, name="transcribe-worker").start()


@app.get("/health")
def health() -> dict:
    info = transcriber.get_device_info()
    return {"status": "ok", "device": info["device"], "device_name": info["name"], "model": transcriber.MODEL_ID}


@app.post("/jobs")
def create_job(req: JobRequest) -> dict:
    job_id = uuid.uuid4().hex
    with _jobs_lock:
        _jobs[job_id] = {"status": "queued", "audio_url": req.audio_url}
    _queue.put(job_id)
    logger.info("job %s queued", job_id)
    return {"job_id": job_id}


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        out: dict = {"status": job["status"]}
        if job["status"] == "done":
            out["segments"] = job["segments"]
        elif job["status"] == "error":
            out["error"] = job.get("error", "unknown")
        return out
