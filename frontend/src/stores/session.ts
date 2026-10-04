import { defineStore } from 'pinia'

// 工作票流程里的岗位：签发、许可、终结、作废分属不同角色，越权操作要挡回。
export type WorkRole = '工作票签发人' | '工作许可人' | '工作负责人' | '值班管理员'

export const WORK_ROLES: WorkRole[] = ['工作票签发人', '工作许可人', '工作负责人', '值班管理员']

// 各岗位在工作票上允许执行的动作（值班管理员只负责作废，不参与签发/许可/终结）。
export const WORKPERMIT_ACTION_ROLES: Record<string, WorkRole[]> = {
  签发许可: ['工作票签发人'],
  办理终结: ['工作许可人'],
  作废工作票: ['值班管理员'],
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    role: '值班管理员' as WorkRole,
    shiftLabel: '白班 08:00-20:00',
    scope: '变电站继电保护定值整定与二次设备检修管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: WorkRole) {
      this.role = role
      this.operator = role
    },
    // 返回该角色是否能执行工作票动作；未登记的动作默认拒绝。
    canRunWorkpermitAction(action: string): boolean {
      return (WORKPERMIT_ACTION_ROLES[action] ?? []).includes(this.role)
    },
  },
})
