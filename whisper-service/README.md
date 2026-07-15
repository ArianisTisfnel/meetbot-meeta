# whisper-service — 會後重轉錄微服務（Breeze-ASR-25）

meetbot 的會後重轉錄引擎：後端的 `retranscription-poller` 會把 Recall 錄音的
下載連結送進來，本服務以 [MediaTek Breeze-ASR-25](https://huggingface.co/MediaTek-Research/Breeze-ASR-25)
（Whisper-large-v2 微調，台灣中文＋中英夾雜優化，Apache-2.0）重轉高品質繁中逐字稿。

**可以跑在另一台機器**（例如區網內有 NVIDIA GPU 的桌機）：後端只透過
`WHISPER_SERVICE_URL` 打 HTTP，不需要同機。

## 安裝

需求：Python 3.10+、ffmpeg（解 mp3/mp4 音軌）。

```bash
cd whisper-service
python -m venv .venv
.venv\Scripts\activate        # Windows；macOS/Linux 用 source .venv/bin/activate

# 1) 先裝 torch（依機器擇一）
pip install torch --index-url https://download.pytorch.org/whl/cu124   # NVIDIA GPU（CUDA 12.x）
pip install torch                                                       # 純 CPU

# 2) 其餘依賴
pip install -r requirements.txt
```

ffmpeg（Windows）：`winget install Gyan.FFmpeg`，裝完重開終端機確認 `ffmpeg -version` 可用。

## 啟動

```bash
uvicorn main:app --host 0.0.0.0 --port 8200
```

- 首次轉錄會從 Hugging Face 下載 ~3GB 模型權重（之後走本地快取）。
- 服務啟動時自動偵測 CUDA：GPU → bf16/fp16；CPU → float32（慢；一小時
  會議可能要轉 20–40 分鐘，但 job 是非同步的，不會卡住後端）。
- 跑在 GPU 桌機時，後端機器的 `backend/.env` 設
  `WHISPER_SERVICE_URL=http://<桌機區網IP>:8200`（記得放行 Windows 防火牆的 8200 port）。

## API

| 端點 | 說明 |
|------|------|
| `GET /health` | `{status, device, device_name, model}` |
| `POST /jobs` `{"audio_url": "..."}` | 服務自行下載音檔（Recall pre-signed URL 免驗證）→ 回 `{job_id}` |
| `GET /jobs/{job_id}` | `{status: queued/processing/done/error, segments?, error?}`；未知 id 回 404 |

`segments` 格式：`[{text, start, end}]`（秒）。

Job store 在記憶體（重啟即失）；後端 poller 收到 404 會自動重送，無需人工介入。

## 冒煙測試

```bash
curl http://localhost:8200/health
curl -X POST http://localhost:8200/jobs -H "Content-Type: application/json" \
     -d "{\"audio_url\": \"https://github.com/ggerganov/whisper.cpp/raw/master/samples/jfk.wav\"}"
curl http://localhost:8200/jobs/<job_id>
```

## 環境變數（選用）

見 `.env.example`。`WHISPER_MODEL_ID` 可換其他 HF Whisper 模型做 A/B 比較。

> 後續 CPU 加速選項：以 `ct2-transformers-converter` 把模型轉成 CTranslate2
> int8 後改用 faster-whisper 推理，速度可提升數倍；目前為簡化部署未採用。
