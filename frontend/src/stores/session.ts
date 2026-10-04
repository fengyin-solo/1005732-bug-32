import { defineStore } from 'pinia'

// 工作票许可/终结/作废都属于许可人职责；其它角色点这些动作要被挡回，页面上可切换身份做越权演示。
export const OPERATOR_ROLES = ['工作许可人', '工作负责人', '值班管理员'] as const
export type OperatorRole = (typeof OPERATOR_ROLES)[number]
export const PERMIT_ROLE: OperatorRole = '工作许可人'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '变电站继电保护定值整定与二次设备检修管理平台',
    role: PERMIT_ROLE as OperatorRole,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    canPermit: (state) => state.role === PERMIT_ROLE,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: OperatorRole) {
      this.role = role
    },
  },
})
