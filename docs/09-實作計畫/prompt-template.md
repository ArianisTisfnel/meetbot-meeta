# Prompt 模板

每個 Phase 開始新聊天室時，使用以下模板。  
**粗體** 是每次需要修改的部分，其餘固定不變。

---

## 模板

```
請實作 meetbot 專案的 **Phase [N] — [Phase 名稱]**。

先讀取以下文件再開始實作：
1. `CLAUDE.md` — 專案脈絡與已完成 Phase 狀態
2. `docs/09-實作計畫/**0[N]-Phase[N]-[名稱].md**` — 本 Phase 完整計畫
3. **[視 Phase 需要，列出 1~2 個相關設計文件，見下方參照表]**
4. （若有）`docs/10-實作報告/Phase[N-1]-報告.md` — 前一 Phase 的注意事項

目前狀態：**[一句話描述，例如「P[N-1] 已完成，backend/src/ 已有 auth middleware 和 project service」]**

完成標準：
- `npx vitest run` 全部通過
- DoD 清單（Phase 計畫文件末尾）全部勾選
- 依 `docs/10-實作報告/_template.md` 格式生成 `docs/10-實作報告/Phase[N]-報告.md`
- 更新 `CLAUDE.md` Phase 完成狀態表
```

---

## 各 Phase 的「視需要」設計文件參照

| Phase | 主要設計文件 | 次要設計文件 |
|-------|------------|------------|
| P1 | `docs/06-後端架構.md` §一~四 | `docs/03-資料庫Schema設計.md` §六~七 |
| P2 | `docs/04-API設計.md` §四~六 | `docs/06-後端架構.md` §二（資料夾結構） |
| P3 | `docs/04-API設計.md` §七 | `docs/03-資料庫Schema設計.md` §4.2~4.3 |
| P4 | `docs/04-API設計.md` §八~九 | `docs/06-後端架構.md` §三（index.ts 流程） |
| P5 | `docs/06-後端架構.md` §五（全） | `docs/02-使用者需求.md` §五（Bot 互動） |
| P6 | `docs/06-後端架構.md` §5.2（摘要部分） | `docs/01-RAG_API_串接文件_v1.1.md` |
| P7 | `docs/05-前端架構.md` 全文 | `docs/04-API設計.md`（API 合約） |

---

## 已填好的各 Phase Prompt（複製貼上即用）

### P1 Prompt

```
⚠️ 前提（由人工確認，非 agent 任務）：
開始前請確認 `docs/09-實作計畫/00-環境設定.md` 的驗收清單全部勾選（
vexa-lite 啟動、app schema 建立、Storage bucket、.env 填寫、prisma db pull + migrate 完成）。

請實作 meetbot 專案的 Phase 1 — 開發基礎設施。

先讀取以下文件再開始實作：
1. `CLAUDE.md`
2. `docs/09-實作計畫/01-Phase1-基礎設施.md`
3. `docs/03-資料庫Schema設計.md` §六~七（migration 步驟）
4. `docs/06-後端架構.md` §一~四（架構與 middleware）

目前狀態：空白專案，只有 docs/ 目錄和 vexa/ 子模組，backend/ 和 frontend/ 尚未建立。

完成標準：
- `npx vitest run` 全部通過（auth middleware 測試）
- `npx tsx backend/src/index.ts` 啟動不拋錯，GET /me 回傳 401
- 依 `docs/10-實作報告/_template.md` 格式生成 `docs/10-實作報告/Phase1-報告.md`
- 更新 `CLAUDE.md` Phase 完成狀態表
```

### P2 Prompt

```
請實作 meetbot 專案的 Phase 2 — 專案與成員管理。

先讀取以下文件再開始實作：
1. `CLAUDE.md`
2. `docs/09-實作計畫/02-Phase2-專案與成員.md`
3. `docs/04-API設計.md` §四~六（User / Project / Member API）
4. `docs/10-實作報告/Phase1-報告.md`（P1 注意事項）

目前狀態：P1 已完成。backend/ 已有 Hono server、auth middleware、Prisma 設定。

完成標準：
- `npx vitest run` 全部通過
- POST /projects 後 Dify 控制台可見新 Knowledge Base
- 依 `docs/10-實作報告/_template.md` 格式生成 `docs/10-實作報告/Phase2-報告.md`
- 更新 `CLAUDE.md` Phase 完成狀態表
```

### P3 Prompt

```
請實作 meetbot 專案的 Phase 3 — 資料管理。

先讀取以下文件再開始實作：
1. `CLAUDE.md`
2. `docs/09-實作計畫/03-Phase3-資料管理.md`
3. `docs/04-API設計.md` §七（Materials API）
4. `docs/03-資料庫Schema設計.md` §4.2~4.3（rollback、SHA-256 判重）
5. `docs/10-實作報告/Phase2-報告.md`

目前狀態：P2 已完成。Project / Member CRUD 可用，Dify createDataset/deleteDataset 已實作。

完成標準：
- `npx vitest run` 全部通過
- 上傳 PDF 後 Dify Knowledge Base 出現該文件；刪除後三方同步消失
- 依 `docs/10-實作報告/_template.md` 格式生成 `docs/10-實作報告/Phase3-報告.md`
- 更新 `CLAUDE.md` Phase 完成狀態表
```

### P4+P5 Prompt（合併一個 chat）

```
請實作 meetbot 專案的 Phase 4（會議基礎）與 Phase 5（Bot Session 與問答）。

先讀取以下文件再開始實作：
1. `CLAUDE.md`
2. `docs/09-實作計畫/04-Phase4-會議基礎.md`
3. `docs/09-實作計畫/05-Phase5-Bot與問答.md`
4. `docs/06-後端架構.md` §三~五（Bot Session 全部）
5. `docs/04-API設計.md` §八~九（Meeting API）
6. `docs/10-實作報告/Phase3-報告.md`

目前狀態：P3 已完成。backend/ 已有 Project/Member/Material 完整實作，Supabase Storage client 已實作。

完成標準（P4）：
- POST /projects/:id/meetings 後，Vexa 控制台顯示 Bot 正在加入 Meet
- GET .../transcriptions 能返回真實逐字稿

完成標準（P5）：
- 說「蜜塔，XXX」Bot 以語音回覆；聊天室輸入 Bot 以文字回覆
- 服務重啟後 ACTIVE 會議自動恢復 WS session
- `npx vitest run` 全部通過

完成後依 `docs/10-實作報告/_template.md` 格式生成：
- `docs/10-實作報告/Phase4-報告.md`
- `docs/10-實作報告/Phase5-報告.md`
- 更新 `CLAUDE.md` Phase 完成狀態表（P4 + P5）
```

### P6 Prompt

```
請實作 meetbot 專案的 Phase 6 — 會議摘要。

先讀取以下文件再開始實作：
1. `CLAUDE.md`
2. `docs/09-實作計畫/06-Phase6-摘要.md`
3. `docs/06-後端架構.md` §5.2（generateSummaryAsync、waitForTranscriptStable）
4. `docs/01-RAG_API_串接文件_v1.1.md`（摘要 Workflow 輸出格式）
5. `docs/10-實作報告/Phase5-報告.md`

目前狀態：P4+P5 已完成。handleSessionClose 中的摘要觸發目前是 stub（不觸發任何操作）。

完成標準：
- Bot 離會後 5~30 秒內，GET .../meetings/:id 的 summary 填入內容
- 無逐字稿或 Dify 失敗時，summary = ''（前端不無限輪詢）
- `npx vitest run` 全部通過
- 依 `docs/10-實作報告/_template.md` 格式生成 `docs/10-實作報告/Phase6-報告.md`
- 更新 `CLAUDE.md` Phase 完成狀態表
```

### P7 Prompt

```
請實作 meetbot 專案的 Phase 7 — 前端。

先讀取以下文件再開始實作：
1. `CLAUDE.md`
2. `docs/09-實作計畫/07-Phase7-前端.md`
3. `docs/05-前端架構.md`（全文，路由、Hook、Component 設計）
4. `docs/04-API設計.md`（API 合約，用於 types/api.ts）
5. `docs/10-實作報告/Phase6-報告.md`

目前狀態：P1~P6 後端全部完成。frontend/ 目錄存在但為空。

完成標準：
- 完整走完「建立專案 → 上傳檔案 → 建立會議 → 問答 → 結束會議 → 摘要出現」
- `npx vitest run` 全部通過（含前端 hook/component 測試）
- 依 `docs/10-實作報告/_template.md` 格式生成 `docs/10-實作報告/Phase7-報告.md`
- 更新 `CLAUDE.md` Phase 完成狀態表
```

---

## 常見調整場景

**「上一個 Phase 有偏差，某個東西不是按計畫實作的」**  
→ 在 Prompt 的「目前狀態」欄加一行：  
`注意：Phase N 報告 §三 有一個偏差，[簡述]，請在實作前先確認`

**「這個 Phase 太大，想分兩次 chat」**  
→ 將 Phase 計畫文件裡的交付物分成兩半，  
第一個 chat 的 Prompt 加：`本次只實作到 [交付物 N]，之後的留給下一個 chat`

**「想讓 agent 只做測試，不動程式碼」**  
→ Prompt 改為：  
`請為 backend/src/services/X.ts 補寫缺少的單元測試，測試 cases 在 Phase N 計畫文件 §三`