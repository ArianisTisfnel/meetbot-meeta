/**
 * 一次性救援腳本：清理「殭屍會議」。
 *
 * 情境：後端重啟時有 Recall 會議進行中 → in-memory session 消失，但 DB 的會議
 * 仍記為 ACTIVE → 結束不了、也因並發上限開不了新會議（startup restore 會跳過
 * Recall 會議，永遠不自清）。詳見 docs/13 backlog「重啟復原 Recall session」。
 *
 * 跑法（從 backend/ 目錄）：
 *   npx tsx --env-file .env scripts/fix-zombie-meetings.ts
 *
 * 安全機制：只處理「建立超過 10 分鐘」的 ACTIVE 會議，剛開始的正常會議不會被誤殺。
 * 跑之前確認一下組員沒有正在進行超過 10 分鐘的真會議。
 */
import { prisma } from '../src/lib/prisma.js'

const threshold = new Date(Date.now() - 10 * 60 * 1000)

const zombies = await prisma.meetingInstance.findMany({
  where: { status: 'ACTIVE', createdAt: { lt: threshold } },
  select: { id: true, name: true, createdAt: true },
})

if (!zombies.length) {
  console.log('沒有殭屍會議（超過 10 分鐘仍 ACTIVE 的），不需處理。')
} else {
  for (const z of zombies) {
    console.log(`清理：${z.name}（建立於 ${z.createdAt.toLocaleString('zh-TW')}）`)
  }
  const result = await prisma.meetingInstance.updateMany({
    where: { status: 'ACTIVE', createdAt: { lt: threshold } },
    // summary 給空字串（非 null）：讓前端停止輪詢摘要
    data: { status: 'ENDED', endedAt: new Date(), summary: '' },
  })
  console.log(`完成：${result.count} 筆會議 ACTIVE → ENDED。前端重新整理後即可建新會議。`)
}

await prisma.$disconnect()
