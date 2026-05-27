# 📘 RAG 系統 API 串接文件

> 對接 Dify 平台。後端負責兩個流程：**(1) 建知識庫 + 上傳 PDF**、**(2) 問問題**。

---

## 🔑 環境變數

```bash
# 建知識庫、上傳檔案、查索引狀態用
DIFY_DATASET_API_KEY=dataset-ZParWOxdgmsz93b1JGwNaaCD

# 問問題用
DIFY_WORKFLOW_API_KEY=app-oL101wsh0vNCzME4TWimu9bo

DIFY_BASE_URL=https://api.dify.ai/v1
```

> ⚠️ 兩把 key 完全不同，用錯會 401。

---

## 🏗️ 整體流程

```
[流程一] 使用者上傳 PDF
   ↓
   建知識庫 → 拿 dataset_id
   ↓
   上傳 PDF + 設定 chunking
   ↓
   等索引完成
   ↓
   📌【要存 DB】dataset_id

[流程二] 使用者問問題
   ↓
   📌【要從 DB 撈】dataset_id
   ↓
   呼叫 Dify Chatflow(帶上 dataset_id)
   ↓
   回傳答案
```

---

# 🟦 流程一：建立知識庫 + 上傳 PDF

## Step 1-1：建立空知識庫

**Request**

```http
POST https://api.dify.ai/v1/datasets
Authorization: Bearer {DIFY_DATASET_API_KEY}
Content-Type: application/json
```

**Body**

```json
{
  "name": "user123_doc_1778500000",
  "permission": "only_me",
  "indexing_technique": "high_quality"
}
```

**Response（200）**

```json
{
  "id": "91ec6710-a9e9-4007-bb44-c3cb5321336e",
  "name": "user123_doc_1778500000",
  ...
}
```

> 📌 **【要存 DB】回傳的 `id` 就是 `dataset_id`，後續所有操作都靠它**

---

## Step 1-2：上傳 PDF + 設定 Chunking

**Request**

```http
POST https://api.dify.ai/v1/datasets/{dataset_id}/document/create-by-file
Authorization: Bearer {DIFY_DATASET_API_KEY}
Content-Type: multipart/form-data
```

**Body**（`multipart/form-data`，兩個欄位）

| 欄位 | 內容 |
|---|---|
| `file` | PDF 檔案本身 |
| `data` | 下面這個 JSON 字串 |

**`data` 欄位的 JSON 內容（chunking 策略統一用這組）**

```json
{
  "indexing_technique": "high_quality",
  "doc_form": "hierarchical_model",
  "process_rule": {
    "mode": "hierarchical",
    "rules": {
      "pre_processing_rules": [
        {"id": "remove_extra_spaces", "enabled": true},
        {"id": "remove_urls_emails", "enabled": false}
      ],
      "parent_mode": "paragraph",
      "segmentation": {
        "separator": "\n\n",
        "max_tokens": 1000,
        "chunk_overlap": 50
      },
      "subchunk_segmentation": {
        "separator": "\n",
        "max_tokens": 300,
        "chunk_overlap": 30
      }
    }
  }
}
```

> 💡 我們團隊統一使用 **Parent-Child 父子分塊**，參數請不要改

**Response（200）**

```json
{
  "document": {
    "id": "abc-def-...",
    ...
  },
  "batch": "20251112164532-xxxxx"
}
```

> 📌 記下回傳的 `batch`，下一步要用

---

## Step 1-3：輪詢索引狀態

**Request**

```http
GET https://api.dify.ai/v1/datasets/{dataset_id}/documents/{batch}/indexing-status
Authorization: Bearer {DIFY_DATASET_API_KEY}
```

**Response**

```json
{
  "data": [
    {
      "id": "...",
      "indexing_status": "completed",
      "completed_segments": 450,
      "total_segments": 450
    }
  ]
}
```

**`indexing_status` 可能值**

| 值 | 意義 | 處理 |
|---|---|---|
| `splitting` | 切 chunk 中 | 繼續輪詢 |
| `indexing` | embedding 中 | 繼續輪詢 |
| `completed` | ✅ 完成 | 可以開始問問題 |
| `error` | ❌ 失敗 | 回傳錯誤給使用者 |

> ⏱️ 建議每 3 秒輪詢一次，timeout 設 10 分鐘

> 📌 **【索引完成後存 DB】** `dataset_id` 此時才算真正可用，這個時間點存進 DB 最保險

---

# 🟦 流程二：問問題

## Step 2-1：撈 dataset_id

> 📌 **【要從 DB 撈】** 根據使用者選擇的知識庫，從 DB 取出對應的 `dataset_id`

---

## Step 2-2：呼叫 Dify Chatflow

**Request**

```http
POST https://api.dify.ai/v1/chat-messages
Authorization: Bearer {DIFY_WORKFLOW_API_KEY}
Content-Type: application/json
```

> ⚠️ 注意這裡用 **Workflow API Key**（`app-` 開頭）

**Body**

```json
{
  "inputs": {
    "dataset_id": "91ec6710-a9e9-4007-bb44-c3cb5321336e"
  },
  "query": "快速排序的時間複雜度?",
  "response_mode": "blocking",
  "conversation_id": "",
  "user": "user-123"
}
```

**欄位說明**

| 欄位 | 必填 | 說明 |
|---|---|---|
| `inputs.dataset_id` | ✅ | 📌 從 DB 撈出來的知識庫 ID |
| `query` | ✅ | 使用者問題 |
| `response_mode` | ✅ | `blocking`（一次回完）或 `streaming`（逐字串流） |
| `conversation_id` | ⚪ | 多輪對話用，第一次空字串 |
| `user` | ✅ | 使用者識別碼 |

**Response（blocking 模式）**

```json
{
  "answer": "快速排序的平均時間複雜度是 O(n log n)...",
  "conversation_id": "xxx-xxx-xxx",
  "message_id": "..."
}
```

> 回傳給前端就用 `answer` 欄位

---

# 🟦 多輪對話（選用）

支援使用者連續追問：

1. 第一次呼叫 `conversation_id` 傳空字串 `""`
2. 從 response 拿到 `conversation_id`
3. 下次呼叫帶上同一個 `conversation_id`，Dify 自動帶上下文

```json
{
  "inputs": {"dataset_id": "..."},
  "query": "那它的最壞情況呢?",
  "conversation_id": "上次拿到的 conversation_id",
  "user": "user-123",
  "response_mode": "blocking"
}
```

---

# 🟦 錯誤處理

| HTTP Status | 原因 | 處理 |
|---|---|---|
| 401 | API Key 錯了 | 檢查環境變數 |
| 404 | dataset_id 不存在 | DB 對應有誤 |
| 429 | 速率限制 | 退避重試 |
| 500 | Dify 內部錯誤 | 重試 1~2 次 |

索引階段若 `indexing_status = "error"` 也要回報使用者「PDF 處理失敗」。

---

# ✅ Checklist

- [ ] 兩把 API Key 放進環境變數
- [ ] 流程一：建知識庫 → 上傳 → 等索引 → **存 dataset_id**
- [ ] 流程二：**撈 dataset_id** → 問問題 → 回傳答案
- [ ] Chunking 策略統一用文件提供的參數
- [ ] 索引輪詢有 timeout
- [ ] 錯誤處理


