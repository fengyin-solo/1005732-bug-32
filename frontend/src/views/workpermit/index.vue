<template>
  <section class="page" data-module="workpermit">
    <header class="page-head">
      <div>
        <h2>工作票许可管理</h2>
        <p class="page-desc">围绕工作票号、工作任务、所属变电站、停电范围办理签发许可与终结；许可、终结时间全系统同一口径。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记工作票</button>
        <button class="btn" type="button" @click="exportRows">导出工作票许可清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <label class="filter-item filter-check">
        <input v-model="todoOnly" type="checkbox" @change="reload" />
        <span>只看待办（已终结、已作废自动退出）</span>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <button v-if="column === '工作票号'" class="link" type="button" @click="openDetail(row)">
              {{ row[column] || '—' }}
            </button>
            <template v-else>{{ formatCell(row, column) }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row.status)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无符合条件的工作票，可先登记工作票</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条工作票记录，待办 {{ pendingCount }} 条</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 详情抽屉：与列表、导出读同一条记录，许可时间不再另算 -->
    <div v-if="drawerRow" class="drawer-mask" @click.self="closeDrawer">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>工作票详情</h3>
          <button class="btn ghost" type="button" @click="closeDrawer">关闭</button>
        </header>
        <dl class="drawer-body">
          <div v-for="field in detailFields" :key="field" class="detail-line">
            <dt>{{ field }}</dt>
            <dd>{{ formatCell(drawerRow, field) }}</dd>
          </div>
          <div class="detail-line">
            <dt>当前状态</dt>
            <dd>{{ drawerRow.status }}</dd>
          </div>
        </dl>

        <div v-if="actionMode === '办理终结'" class="drawer-form">
          <label class="filter-item">
            <span>终结时间（必填，格式 YYYY-MM-DD HH:mm）</span>
            <input v-model="finishTime" type="datetime-local" />
          </label>
        </div>

        <p v-if="actionMode" class="drawer-tip">
          当前岗位「{{ store.role }}」办理「{{ actionMode }}」；越权操作会被挡回。
        </p>
        <p v-if="drawerError" class="error-text">{{ drawerError }}</p>

        <footer class="drawer-actions">
          <template v-if="actionMode">
            <button class="btn primary" type="button" @click="confirmDrawerAction">确认提交</button>
            <button class="btn ghost" type="button" @click="actionMode = ''">取消</button>
          </template>
          <template v-else>
            <button
              v-for="action in availableActions(drawerRow.status)"
              :key="action"
              class="btn"
              type="button"
              @click="startAction(action)"
            >
              {{ action }}
            </button>
          </template>
        </footer>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { isWorkpermitTerminalStatus, submitWorkpermitAction } from '@/api/workpermit-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('workpermit')
const columns = ['工作票号', '工作任务', '所属变电站', '停电范围', '工作负责人', '许可时间', '终结时间', '许可状态']
const detailFields = columns
const statuses = ['待签发', '已许可', '已终结', '已作废']
// 各状态允许办理的动作：已作废不许再签发，待签发不能直接终结（越级拒收由服务端再兜一遍）。
const STATUS_ACTIONS: Record<string, string[]> = {
  待签发: ['签发许可', '作废工作票'],
  已许可: ['办理终结', '作废工作票'],
  已终结: [],
  已作废: [],
}

const rows = ref<EntryRow[]>([])
const allRowsCache = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const todoOnly = ref(true)
const filterFields = columns.slice(0, 3)

const drawerRow = ref<EntryRow | null>(null)
const actionMode = ref('')
const finishTime = ref('')
const drawerError = ref('')

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: allRowsCache.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '待签发工作票', value: countByStatus('待签发') },
  { label: '已许可工作票', value: countByStatus('已许可') },
  { label: '已终结工作票', value: countByStatus('已终结') },
])

const pendingCount = computed(() => allRowsCache.value.filter((row) => row.pending).length)

function countByStatus(status: string): number {
  return allRowsCache.value.filter((row) => String(row.status) === status).length
}

function availableActions(status: string): string[] {
  return STATUS_ACTIONS[String(status)] ?? []
}

// 时间格统一显示记录里的原值（空就是「—」），列表和详情抽屉走同一个函数，杜绝两处对不上。
function formatCell(row: EntryRow, field: string): string {
  const value = row[field]
  return value === undefined || value === null || String(value) === '' ? '—' : String(value)
}

function resetFilters() {
  filters.value = {}
  todoOnly.value = true
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '工作票登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  // 终结需要填终结时间，打开抽屉走表单；签发、作废直接提交。
  if (action === '办理终结') {
    openDetail(row)
    startAction(action)
    return
  }
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

function openDetail(row: EntryRow) {
  drawerRow.value = row
  actionMode.value = ''
  finishTime.value = ''
  drawerError.value = ''
}

function closeDrawer() {
  drawerRow.value = null
  actionMode.value = ''
  drawerError.value = ''
}

function startAction(action: string) {
  actionMode.value = action
  drawerError.value = ''
  if (action === '办理终结') {
    finishTime.value = formatDatetimeLocal(new Date())
  }
}

function formatDatetimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function confirmDrawerAction() {
  if (!drawerRow.value || !actionMode.value) {
    return
  }
  const action = actionMode.value
  // datetime-local 提交时转成与「许可时间」一致的 YYYY-MM-DD HH:mm 口径。
  const payload =
    action === '办理终结'
      ? { action, role: store.role, 终结时间: finishTime.value.replace('T', ' ') }
      : { action, role: store.role }
  // 直接走领域服务，保证与列表行内动作是同一条校验链。
  const result = submitWorkpermitAction(Number(drawerRow.value.id), payload)
  if (!result.ok) {
    drawerError.value = result.message
    return
  }
  closeDrawer()
  errorMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    allRowsCache.value = payload.items
    rows.value = todoOnly.value
      ? payload.items.filter((row) => !isWorkpermitTerminalStatus(String(row.status)))
      : payload.items
    total.value = rows.value.length
    if (drawerRow.value) {
      const latest = payload.items.find((row) => Number(row.id) === Number(drawerRow.value?.id))
      drawerRow.value = latest ?? drawerRow.value
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '工作票许可列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.filter-check {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.filter-check input {
  margin: 0;
}
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  justify-content: flex-end;
  z-index: 20;
}
.drawer {
  width: 420px;
  max-width: 92vw;
  background: #fff;
  min-height: 100vh;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: -8px 0 24px rgba(15, 23, 42, 0.18);
}
.drawer-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.drawer-head h3 {
  margin: 0;
  font-size: 16px;
}
.drawer-body {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.detail-line {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  border-bottom: 1px dashed var(--border);
  padding-bottom: 6px;
}
.detail-line dt {
  color: var(--muted);
}
.detail-line dd {
  margin: 0;
  text-align: right;
}
.drawer-form {
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
.drawer-tip {
  font-size: 12px;
  color: var(--muted);
  margin: 0;
}
.drawer-actions {
  margin-top: auto;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
</style>
