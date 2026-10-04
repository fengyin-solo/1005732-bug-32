import { moduleMeta } from '@/api/local-service'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'
import { PERMIT_ROLE, type OperatorRole } from '@/stores/session'

// 工作票许可专用服务：许可时间、终结时间只在动作发生时盖进同一条记录，
// 列表、详情抽屉、导出清单全部读这份数据，不再各算一遍。

const KEY = 'workpermit'
const TRANSFORMER_KEY = 'transformermaint'

const TICKET_NO = '工作票号'
const PERMIT_TIME = '许可时间'
const FINISH_TIME = '终结时间'
const STATUS_FIELD = '许可状态'

export const PERMIT_TODO_STATUSES = ['待签发', '已许可']
export const FINAL_STATUSES = ['已终结', '已作废']

// 终结时必须写全的三格：票号、许可时间、终结时间。
const REQUIRED_AT_FINISH = [TICKET_NO, PERMIT_TIME, FINISH_TIME]
// 签发时票号必须先有，许可时间由本次许可盖入，终结时间终结时再盖。
const REQUIRED_AT_ISSUE = [TICKET_NO]

function stampNow(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`
  )
}

function deny(message: string): ActionResult {
  return { ok: false, message }
}

function findRow(id: number): { rows: EntryRow[]; index: number; row: EntryRow } | ActionResult {
  const rows = listRows(KEY)
  const index = rows.findIndex((item) => Number(item.id) === id)
  if (index < 0) {
    return deny(`没有找到编号为 ${id} 的工作票`)
  }
  return { rows, index, row: rows[index] }
}

function missingFields(row: EntryRow, fields: string[]): string[] {
  return fields.filter((field) => String(row[field] ?? '').trim() === '')
}

// 许可通过后落到主变检修「待开工」清单；同一张票重复许可只留一条，靠票号幂等。
function linkTransformerTodo(ticket: EntryRow): void {
  const rows = listRows(TRANSFORMER_KEY)
  const ticketNo = String(ticket[TICKET_NO])
  const exists = rows.some((item) => String(item['关联工作票号'] ?? '') === ticketNo)
  if (exists) {
    return
  }
  const matched = String(ticket['工作任务'] ?? '').match(/#?\d+号?主变/)
  const transformerName = matched
    ? `${String(ticket['所属变电站'] ?? '')} ${matched[0]}`.trim()
    : String(ticket['工作任务'] ?? ticketNo)
  const nextId = rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const todo: EntryRow = {
    id: nextId,
    status: '待开工',
    pending: true,
    abnormal: false,
    检修编号: `JP-${ticketNo}`,
    主变名称: transformerName,
    检修类别: '工作票联动检修',
    停电范围: String(ticket['停电范围'] ?? ''),
    检修班组: String(ticket['工作负责人'] ?? ''),
    计划工期: '',
    完成日期: '',
    检修状态: '待开工',
    关联工作票号: ticketNo,
  }
  saveRows(TRANSFORMER_KEY, [...rows, todo])
}

export function issuePermit(id: number, role: OperatorRole): ActionResult {
  if (role !== PERMIT_ROLE) {
    return deny(`越权操作被挡回：签发许可仅限${PERMIT_ROLE}办理，当前身份为「${role}」`)
  }
  const found = findRow(id)
  if ('ok' in found) {
    return found
  }
  const { rows, index, row } = found
  const status = String(row.status)
  if (status === '已许可') {
    return deny('这张工作票已经许可过，重复提交许可只保留一条，无需再次签发')
  }
  if (status === '已终结') {
    return deny('工作票已终结，不能再签发许可；如确需复工请重新登记工作票')
  }
  if (status === '已作废') {
    return deny('已经作废的工作票不许再签发')
  }
  if (status !== '待签发') {
    return deny(`越级操作被拒收：工作票当前为「${status}」，只能从「待签发」签发许可`)
  }
  const missing = missingFields(row, REQUIRED_AT_ISSUE)
  if (missing.length) {
    return deny(`许可被挡回：缺少${missing.map((field) => `「${field}」`).join('、')}，请补全后再签发`)
  }
  // 沿用既有许可口径：许可时间取许可通过这一刻，一次盖定，终结不再改写。
  const permitTime = String(row[PERMIT_TIME] ?? '').trim() || stampNow()
  const updated: EntryRow = {
    ...row,
    status: '已许可',
    pending: true,
    abnormal: false,
    [PERMIT_TIME]: permitTime,
    [STATUS_FIELD]: '已许可',
  }
  const next = [...rows]
  next[index] = updated
  saveRows(KEY, next)
  linkTransformerTodo(updated)
  return {
    ok: true,
    message: `工作票 ${String(updated[TICKET_NO])} 已许可，许可时间 ${permitTime}，结论已进入主变检修待开工清单`,
  }
}

export function finishPermit(id: number, role: OperatorRole): ActionResult {
  if (role !== PERMIT_ROLE) {
    return deny(`越权操作被挡回：办理终结仅限${PERMIT_ROLE}办理，当前身份为「${role}」`)
  }
  const found = findRow(id)
  if ('ok' in found) {
    return found
  }
  const { rows, index, row } = found
  const status = String(row.status)
  if (status === '待签发') {
    return deny('越级操作被拒收：工作票尚未许可，不能直接办理终结')
  }
  if (status === '已终结') {
    return deny('工作票已经终结，不用重复办理')
  }
  if (status === '已作废') {
    return deny('工作票已作废，不能办理终结')
  }
  if (status !== '已许可') {
    return deny(`越级操作被拒收：工作票当前为「${status}」，不允许办理终结`)
  }
  // 终结时间取办理终结这一刻；三格缺一格都挡回，并明确报缺哪一格。
  const stamp = { ...row, [FINISH_TIME]: String(row[FINISH_TIME] ?? '').trim() || stampNow() }
  const missing = missingFields(stamp, REQUIRED_AT_FINISH)
  if (missing.length) {
    return deny(`终结被挡回：缺少${missing.map((field) => `「${field}」`).join('、')}，请补全后再办理终结`)
  }
  const updated: EntryRow = {
    ...stamp,
    status: '已终结',
    pending: false, // 办完终结自动退出待办清单
    abnormal: false,
    [STATUS_FIELD]: '已终结',
  }
  const next = [...rows]
  next[index] = updated
  saveRows(KEY, next)
  return {
    ok: true,
    message: `工作票 ${String(updated[TICKET_NO])} 已终结，终结时间 ${String(updated[FINISH_TIME])}，已退出待办清单`,
  }
}

export function cancelPermit(id: number, role: OperatorRole): ActionResult {
  if (role !== PERMIT_ROLE) {
    return deny(`越权操作被挡回：作废工作票仅限${PERMIT_ROLE}办理，当前身份为「${role}」`)
  }
  const found = findRow(id)
  if ('ok' in found) {
    return found
  }
  const { rows, index, row } = found
  const status = String(row.status)
  if (status === '已作废') {
    return deny('工作票已经作废，无需重复操作')
  }
  if (status === '已终结') {
    return deny('越级操作被拒收：工作票已终结，不能再作废；作废只适用于待签发或已许可的票')
  }
  if (status !== '待签发' && status !== '已许可') {
    return deny(`越级操作被拒收：工作票当前为「${status}」，不允许作废`)
  }
  const updated: EntryRow = {
    ...row,
    status: '已作废',
    pending: false,
    abnormal: true,
    [STATUS_FIELD]: '已作废',
  }
  const next = [...rows]
  next[index] = updated
  saveRows(KEY, next)
  return { ok: true, message: `工作票 ${String(updated[TICKET_NO] ?? id)} 已作废，作废后不能再签发` }
}

export function runWorkPermitAction(action: string, id: number, role: OperatorRole): ActionResult {
  if (action === '签发许可') {
    return issuePermit(id, role)
  }
  if (action === '办理终结') {
    return finishPermit(id, role)
  }
  if (action === '作废工作票') {
    return cancelPermit(id, role)
  }
  return deny(`工作票没有登记「${action}」这个动作`)
}

export function getWorkPermit(id: number): EntryRow | null {
  return listRows(KEY).find((item) => Number(item.id) === id) ?? null
}

function csvCell(value: string | number | boolean): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// 导出与列表、详情读同一批行、同一组字段，许可/终结时间不再另算。
export function exportWorkPermitList(): { filename: string; content: string } {
  const meta = moduleMeta(KEY)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(KEY)) {
    lines.push(
      [row.id, ...meta.fields.map((field) => csvCell(row[field] ?? '')), csvCell(row.status)].join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadWorkPermitList(): void {
  const { filename, content } = exportWorkPermitList()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
