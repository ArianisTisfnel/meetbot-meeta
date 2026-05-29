# Phase [N] 實作報告 — [Phase 名稱]

|項目|內容|
|----|-----|
|Phase|P[N]|
|完成日期|YYYY-MM-DD|
|實作耗時（約）|X 小時|

---

## 一、DoD 檢查清單

> 從 `docs/09-實作計畫/0N-Phase[N]-*.md` 的 Definition of Done 複製並勾選

- [ ] [DoD item 1]
- [ ] [DoD item 2]
- [ ] 所有單元測試通過（`npx vitest run`）

---

## 二、交付物確認

| 計畫中的交付物 | 狀態 | 備註 |
|--------------|------|------|
| [交付物 1] | ✅ 完成 / ⚠️ 部分 / ❌ 跳過 | |
| [交付物 2] | ✅ 完成 | |

---

## 三、與計畫的偏差

> 若完全按計畫實作，此節填「無偏差」即可

- **[偏差項目]**：[說明原因，例如 Vexa API 行為與文件不符，改用 X 方案]

---

## 四、測試結果

```
Tests:  X passed, Y failed, Z skipped
Files:  N test files
```

失敗的測試（若有）：
- `test-name`：[失敗原因，是否為已知問題]

---

## 五、下一 Phase 注意事項

> 給 P[N+1] 的 chat 看的重要提示

- [例：session-store.ts 中的 X 函式目前是 stub，P[N+1] 需填入真實實作]
- [例：vexa.ts 的 Y endpoint 在本地測試時需要 Vexa-lite 已啟動]

---

## 六、需要更新 CLAUDE.md 的項目

- Phase 完成狀態表：P[N] → ✅ 完成
- [若有新的關鍵決策需記錄]

---

*報告結尾*