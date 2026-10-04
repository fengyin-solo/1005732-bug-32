<template>
  <section class="page" data-module="workpermit">
    <header class="page-head">
      <div>
        <h2>工作票许可管理</h2>
        <p class="page-desc">维护工作票，围绕工作票号、工作任务、所属变电站、停电范围做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <label class="role-switch">
          当前身份
          <select :value="store.role" @change="switchRole(($event.target as HTMLSelectElement).value)">
            <option v-for="role in OPERATOR_ROLES" :key="role" :value="role">{{ role }}</option>
          </select>
        </label>
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
          <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">查看</button>
            <button
              v-for="action in actions"
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
          <td :colspan="columns.length + 2" class="empty-state">暂无工作票许可数据，可先登记工作票</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条工作票许可记录，待办 {{ pendingCount }} 条（已终结、已作废自动退出待办）</span>
      <span v-if="feedback" :class="feedback.ok ? 'success-text' : 'error-text'">{{ feedback.text }}</span>
    </footer>

    <div v-if="detail" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="工作票详情">
        <header class="drawer-head">
          <h3>工作票详情 · {{ detail['工作票号'] }}</h3>
          <button class="link" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="drawer-body">
          <div v-for="field in columns" :key="field" class="drawer-row">
            <dt>{{ field }}</dt>
            <dd>{{ formatCell(detail, field) }}</dd>
          </div>
          <div class="drawer-row">
            <dt>当前状态</dt>
            <dd>{{ detail.status }}<span v-if="!detail.pending" class="tag tag-done">已退出待办</span></dd>
          </div>
        </dl>
        <footer class="drawer-foot">
          <button
            v-for="action in actions"
            :key="action"
            class="btn"
            type="button"
            @click="runAction(action, detail)"
          >
            {{ action }}
          </button>
        </footer>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadWorkPermitList,
  runWorkPermitAction,
  getWorkPermit,
} from '@/api/workpermit-service'
import { listEntries, moduleMeta } from '@/api/local-service'
import { OPERATOR_ROLES, useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('workpermit')
// 「许可状态」列与状态机同源展示，表格不再重复一列。
const columns = ["工作票号", "工作任务", "所属变电站", "停电范围", "工作负责人", "许可时间", "终结时间"]
const actions = ["签发许可", "办理终结", "作废工作票"]
const statuses = ["待签发", "已许可", "已终结", "已作废"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const filters = ref<Record<string, string>>({})
const filterFields = ["工作票号", "工作任务", "所属变电站"]
const feedback = ref<{ ok: boolean; text: string } | null>(null)
const detailId = ref<number | null>(null)

// 详情抽屉与列表读的是同一份本地数据（listRows），许可时间不可能再出现两处不一致。
const detail = computed<EntryRow | null>(() =>
  detailId.value === null ? null : getWorkPermit(detailId.value),
)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 已终结/已作废的票 pending 已被服务层清掉，不再以「状态最后一位」推算待办。
const pendingCount = computed(() => rows.value.filter((row) => row.pending).length)

const stats = computed(() => [
  { label: '待办工作票', value: pendingCount.value },
  { label: '已许可工作票', value: countByStatus('已许可') },
  { label: '已终结工作票', value: countByStatus('已终结') },
])

function countByStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

// 时间格未盖戳时统一显示「—」，列表与抽屉共用这一个口径。
function formatCell(row: EntryRow, field: string): string | number | boolean {
  const value = row[field]
  return value === undefined || value === '' ? '—' : value
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadWorkPermitList()
}

function openCreate() {
  feedback.value = { ok: false, text: '工作票登记入口尚未接入审批流' }
}

function openDetail(row: EntryRow) {
  detailId.value = Number(row.id)
}

function closeDetail() {
  detailId.value = null
}

function switchRole(role: string) {
  store.setRole(role as (typeof OPERATOR_ROLES)[number])
}

function runAction(action: string, row: EntryRow) {
  const result = runWorkPermitAction(action, Number(row.id), store.role)
  feedback.value = { ok: result.ok, text: result.message }
  if (result.ok) {
    reload()
  }
}

function reload() {
  feedback.value = null
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    feedback.value = {
      ok: false,
      text: error instanceof Error ? error.message : '工作票许可列表读取失败',
    }
  }
}

onMounted(reload)
</script>
