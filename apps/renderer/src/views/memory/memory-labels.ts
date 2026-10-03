import type { MemoryRecord } from "@mycompanion/shared";

export const typeText: Record<MemoryRecord["type"], string> = {
  fact: "事实",
  state: "状态",
  goal: "目标",
  relationship: "关系",
};

export const scopeText: Record<MemoryRecord["scope"], string> = {
  story: "本故事",
  character: "角色共享",
  user: "用户全局",
};

export const statusText: Record<MemoryRecord["status"], string> = {
  active: "生效中",
  pending: "待确认",
  superseded: "已被取代",
  disabled: "已停用",
  orphaned: "来源不可达",
};

export const relationText: Record<NonNullable<MemoryRecord["reconciliation"]>["kind"], string> = {
  duplicate: "重复表述", conflict: "互相矛盾", temporal_update: "状态随时间变化", unrelated: "独立事实", uncertain: "关系未确定",
};
