import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'substation-protection:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 规整历史工作票数据：许可/终结时间只以记录字段为准，
// 待签发不许预填许可时间；未终结的清空终结时间；终态（已终结/已作废）退出待办。
function normalizeWorkpermits(rows: EntryRow[]): EntryRow[] {
  return rows.map((row) => {
    const status = String(row.status)
    const next: EntryRow = { ...row }
    if (status === '待签发') {
      next['许可时间'] = ''
      next['终结时间'] = ''
      next['许可状态'] = '待签发'
      next.pending = true
    } else if (status === '已许可') {
      if (String(next['许可时间'] ?? '').trim() === '') {
        next['许可时间'] = ''
      }
      next['终结时间'] = ''
      next['许可状态'] = '已许可'
      next.pending = true
      next.abnormal = false
    } else if (status === '已终结' || status === '已作废') {
      next.pending = false
      next['许可状态'] = status
      if (status === '已作废') {
        next.abnormal = true
      }
    }
    return next
  })
}

function normalizeAll(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  if (Array.isArray(data.workpermit)) {
    return { ...data, workpermit: normalizeWorkpermits(data.workpermit) }
  }
  return data
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = normalizeAll({ ...fallback, ...parsed })
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
    return merged
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
