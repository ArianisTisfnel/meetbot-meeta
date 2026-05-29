# Phase 2 — 專案與成員管理

|項目|內容|
|----|-----|
|Phase|P2|
|前置條件|P1 完成（DB migration、auth middleware）|
|參考文件|`04-API設計.md` §四~六、`06-後端架構.md` §二（資料夾結構）|

---

## 一、交付物

1. **後端** `GET /me`、`GET /users/lookup`
2. **後端** 專案 CRUD（`/projects`）+ Dify dataset 建立/刪除
3. **後端** 成員管理（`/projects/:id/members`）
4. **Dify client** (`src/lib/dify.ts`)：`createDataset`、`deleteDataset` 函式

---

## 二、實作順序

### 2.1 Dify Client 基礎（`src/lib/dify.ts`）

此 Phase 只需實作 Knowledge Base 相關函式：

```typescript
export async function createDataset(name: string): Promise<string>
// POST /datasets → 回傳 dataset.id

export async function deleteDataset(datasetId: string): Promise<void>
// DELETE /datasets/{datasetId}
```

重點：使用 `DIFY_DATASET_API_KEY`（`dataset-...` 開頭），加 `Authorization: Bearer` header。

### 2.2 Project Service（`src/services/project.service.ts`）

依 `04-API設計.md §五` 實作：

- `listProjects(vexaUserId, params)`：UNION 查詢（owner + participant），含 search / type / order / page
- `createProject(vexaUserId, name)`：先 Dify createDataset，再 Prisma create；Dify 成功後 Prisma 失敗需 rollback deleteDataset
- `getProject(projectId, vexaUserId)`：驗證存取權（owner 或有效 participant）
- `updateProject(projectId, vexaUserId, name)`：Owner only
- `deleteProject(projectId, vexaUserId)`：串行執行 `03-資料庫Schema設計.md §4.1` 的連鎖清理

**關鍵邏輯**：`listProjects` 需要 LEFT JOIN project_members，並組合 `role` 和 `permissions` 欄位。

### 2.3 Member Service（`src/services/member.service.ts`）

依 `04-API設計.md §六` 實作：

- `getMembers(projectId, vexaUserId)`
- `inviteMember(projectId, ownerVexaUserId, email, permissions)`：
  1. raw query 查 `public.users WHERE email = ?`
  2. 若無 → `USER_NOT_FOUND_IN_VEXA` 422
  3. Prisma create ProjectMember
- `updateMemberPermissions(projectId, ownerVexaUserId, targetVexaUserId, permissions)`
- `removeMember(projectId, ownerVexaUserId, targetVexaUserId)`

### 2.4 路由層（`src/routes/`）

建立 `me.ts`、`users.ts`、`projects.ts`、`members.ts`，各自只做 HTTP 綁定，業務邏輯委派給 service。

在 `src/routes/index.ts` 彙整所有路由，於 `src/index.ts` 掛載。

---

## 三、本 Phase 的單元測試

新增 `tests/mocks/dify.mock.ts`：

```typescript
export const mockDify = {
  createDataset: vi.fn().mockResolvedValue('dataset-abc123'),
  deleteDataset: vi.fn().mockResolvedValue(undefined),
  // 其餘函式 P3/P5 陸續補充
}
vi.mock('../../../backend/src/lib/dify', () => mockDify)
```

### `tests/unit/backend/services/project.service.test.ts`

需覆蓋的 cases：
1. `createProject` 正常流程 → 回傳含 difyDatasetId 的 Project
2. `createProject` Dify 失敗 → 拋錯，不呼叫 Prisma create
3. `createProject` Prisma 失敗 → 呼叫 `deleteDataset` rollback
4. `deleteProject` 串行清理 materials → soft delete 三方同步 → deleteDataset → deletedAt
5. `getProject` 非成員 → 拋 403 PERMISSION_DENIED
6. `getProject` 所有 permissions 為 false 的 member → 拋 403 PERMISSION_DENIED

### `tests/unit/backend/services/member.service.test.ts`

需覆蓋的 cases：
1. `inviteMember` email 不存在 → 422 USER_NOT_FOUND_IN_VEXA
2. `inviteMember` 已是成員（Prisma P2002）→ 409 ALREADY_MEMBER
3. `updateMemberPermissions` 非 owner 呼叫 → 403 PERMISSION_DENIED
4. `removeMember` 嘗試移除 owner → 403（不可移除所有者）

---

## 四、Definition of Done

- [ ] `POST /projects` 建立後 Dify 控制台可見新 Knowledge Base
- [ ] `GET /projects` 分頁、搜尋、type 篩選均正確
- [ ] `DELETE /projects/:id` 後 Dify Knowledge Base 已刪除
- [ ] `POST /projects/:id/members` 使用不存在的 email → 422
- [ ] `npx vitest run` 所有測試通過（含 P1）
- [ ] 更新 `CLAUDE.md` 標記 P2 完成

---

*文件結尾*