import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * 取得使用者的顯示名稱。
 * Vexa 的 public.users.name 常為 null，此時退而取 email 的 @ 前段，
 * 避免「名稱」與「email」兩欄顯示相同字串。
 */
export function displayName(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  if (name?.trim()) return name
  if (email?.trim()) return email.split('@')[0]
  return '未知使用者'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
