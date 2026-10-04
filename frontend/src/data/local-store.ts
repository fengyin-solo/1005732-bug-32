import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'substation-protection:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
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
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

// 老版本数据里「已终结」工作票仍挂着 pending（终结不是最后一个状态，通用流转算错了），
// 读到时顺手修正；许可状态列同样以状态机为准对齐，保证列表、详情、导出同源。
function repairLegacyRows(entries: Record<string, EntryRow[]>): boolean {
  const rows = entries['workpermit']
  if (!rows) {
    return false
  }
  let changed = false
  for (const row of rows) {
    const status = String(row.status)
    if (status !== '待签发' && status !== '已许可' && status !== '已终结' && status !== '已作废') {
      continue
    }
    const shouldPending = status === '待签发' || status === '已许可'
    if (Boolean(row.pending) !== shouldPending) {
      row.pending = shouldPending
      changed = true
    }
    if (status === '已作废' && !Boolean(row.abnormal)) {
      row.abnormal = true
      changed = true
    }
    if (String(row['许可状态'] ?? '') !== status) {
      row['许可状态'] = status
      changed = true
    }
  }
  return changed
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
    if (repairLegacyRows(cache) && typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
    }
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
