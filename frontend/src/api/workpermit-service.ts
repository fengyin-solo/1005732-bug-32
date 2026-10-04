import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'
import { WORKPERMIT_ACTION_ROLES, type WorkRole } from '@/stores/session'

// 工作票流程专用接口：列表、详情抽屉、导出都只认记录里的「许可时间」「终结时间」两个字段，
// 不再按签发时刻或负责人签字时刻另算，保证三处口径一致。
export const WORKPERMIT_KEY = 'workpermit'
const TRANSFORMERMAINT_KEY = 'transformermaint'

// 终态：进入这两个状态后自动退出待办（pending=false）。
const TERMINAL_STATUSES = ['已终结', '已作废']
// 办理终结时必须齐全的三格：缺哪一格就明说哪一格。
const REQUIRED_FIELDS = ['工作票号', '许可时间', '终结时间'] as const

export type WorkpermitActionInput = {
  action: string
  role: WorkRole
  终结时间?: string
}

// 许可时间的既有口径：许可通过那一刻落到记录的「许可时间」字段（精确到分钟）。
export function currentPermitStamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.includes(status)
}

// 许可通过后，结论落到主变检修的「待开工」清单；同一工作票号只挂一条，重复许可不新增。
function ensureTransformerTodo(ticket: EntryRow): void {
  const rows = listRows(TRANSFORMERMAINT_KEY)
  const ticketNo = String(ticket['工作票号'] ?? '')
  if (rows.some((row) => String(row['检修编号']) === ticketNo)) {
    return
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const todo: EntryRow = {
    id: nextId,
    status: '待开工',
    pending: true,
    abnormal: false,
    检修编号: ticketNo,
    主变名称: String(ticket['工作任务'] ?? ''),
    检修类别: '工作票许可开工',
    停电范围: String(ticket['停电范围'] ?? ''),
    检修班组: String(ticket['工作负责人'] ?? ''),
    计划工期: '',
    完成日期: '',
    检修状态: '待开工',
  }
  saveRows(TRANSFORMERMAINT_KEY, [...rows, todo])
}

// 工作票动作入口：先验权限、再验状态机、最后验必填字段，任何一关不过都挡回并说明原因。
export function submitWorkpermitAction(id: number, input: WorkpermitActionInput): ActionResult {
  const { action, role } = input

  const allowedRoles = WORKPERMIT_ACTION_ROLES[action]
  if (!allowedRoles) {
    return { ok: false, message: `工作票没有登记「${action}」这个动作` }
  }
  if (!allowedRoles.includes(role)) {
    return {
      ok: false,
      message: `越权操作已挡回：当前岗位「${role}」无权${action}，该操作仅限${allowedRoles.join('、')}办理`,
    }
  }

  const rows = listRows(WORKPERMIT_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的工作票` }
  }

  const current = rows[index]
  const status = String(current.status)

  if (action === '签发许可') {
    if (status === '已许可') {
      return { ok: false, message: '该工作票已许可，重复提交只保留一条，无需再次签发' }
    }
    if (status === '已终结') {
      return { ok: false, message: '工作票已终结，不能再签发，禁止越级流转' }
    }
    if (status === '已作废') {
      return { ok: false, message: '工作票已作废，不得再签发' }
    }
    if (String(current['工作票号'] ?? '').trim() === '') {
      return { ok: false, message: '签发被挡回：缺少「工作票号」，补全后再提交' }
    }
    const updated: EntryRow = {
      ...current,
      status: '已许可',
      pending: true,
      abnormal: false,
      许可时间: currentPermitStamp(),
      终结时间: '',
      许可状态: '已许可',
    }
    const next = [...rows]
    next[index] = updated
    saveRows(WORKPERMIT_KEY, next)
    ensureTransformerTodo(updated)
    return { ok: true, message: `许可通过，许可时间 ${updated['许可时间']}，已进入主变检修待开工清单` }
  }

  if (action === '办理终结') {
    if (status === '待签发') {
      return { ok: false, message: '工作票尚未许可，不能直接办理终结，越级流转拒收' }
    }
    if (status === '已作废') {
      return { ok: false, message: '工作票已作废，不能办理终结' }
    }
    if (status === '已终结') {
      return { ok: false, message: '工作票已终结，无需重复办理' }
    }
    const values: Record<string, string> = {
      工作票号: String(current['工作票号'] ?? '').trim(),
      许可时间: String(current['许可时间'] ?? '').trim(),
      终结时间: (input['终结时间'] ?? '').trim(),
    }
    const missing = REQUIRED_FIELDS.filter((field) => values[field] === '')
    if (missing.length > 0) {
      return { ok: false, message: `终结被挡回：缺少${missing.map((field) => `「${field}」`).join('、')}，请补齐后再提交` }
    }
    if (values['终结时间'] < values['许可时间']) {
      return { ok: false, message: '终结被挡回：「终结时间」早于「许可时间」，请核对后再提交' }
    }
    const updated: EntryRow = {
      ...current,
      status: '已终结',
      pending: false, // 办完终结立即退出待办清单，不留残留记录
      abnormal: false,
      终结时间: values['终结时间'],
      许可状态: '已终结',
    }
    const next = [...rows]
    next[index] = updated
    saveRows(WORKPERMIT_KEY, next)
    return { ok: true, message: `工作票已终结，终结时间 ${updated['终结时间']}，已退出待办清单` }
  }

  if (action === '作废工作票') {
    if (status === '已作废') {
      return { ok: false, message: '工作票已经是作废状态，无需重复作废' }
    }
    if (status === '已终结') {
      return { ok: false, message: '工作票已终结，不能再作废' }
    }
    const updated: EntryRow = {
      ...current,
      status: '已作废',
      pending: false,
      abnormal: true,
      许可状态: '已作废',
    }
    const next = [...rows]
    next[index] = updated
    saveRows(WORKPERMIT_KEY, next)
    return { ok: true, message: '工作票已作废，作废后不得再签发' }
  }

  return { ok: false, message: `工作票不支持「${action}」操作` }
}

export { isTerminal as isWorkpermitTerminalStatus }
