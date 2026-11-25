import type { NodeType, Status } from "@tchain/core";

export interface StatusMeta {
  label: string;
  shortLabel: string;
  accent: string;
  bg: string;
  border: string;
  text: string;
}

export const STATUS_META: Record<Status, StatusMeta> = {
  todo: {
    label: "待推进",
    shortLabel: "待办",
    accent: "#64748b",
    bg: "#f1f5f9",
    border: "#cbd5e1",
    text: "#334155"
  },
  active: {
    label: "进行中",
    shortLabel: "进行中",
    accent: "#2563eb",
    bg: "#eff6ff",
    border: "#3b82f6",
    text: "#1d4ed8"
  },
  blocked: {
    label: "阻塞 / 待拍板",
    shortLabel: "阻塞",
    accent: "#d97706",
    bg: "#fffbeb",
    border: "#f59e0b",
    text: "#b45309"
  },
  done: {
    label: "已完成",
    shortLabel: "已完成",
    accent: "#059669",
    bg: "#ecfdf5",
    border: "#10b981",
    text: "#047857"
  },
  parked: {
    label: "已搁置",
    shortLabel: "搁置",
    accent: "#64748b",
    bg: "#f1f5f9",
    border: "#94a3b8",
    text: "#475569"
  },
  discarded: {
    label: "已否决",
    shortLabel: "否决",
    accent: "#94a3b8",
    bg: "#f8fafc",
    border: "#cbd5e1",
    text: "#64748b"
  }
};

export interface NodeTypeMeta {
  label: string;
  badgeBg: string;
  badgeText: string;
}

export const NODE_TYPE_META: Record<NodeType, NodeTypeMeta> = {
  goal: { label: "目标", badgeBg: "#ede9fe", badgeText: "#6d28d9" },
  decision: { label: "决策", badgeBg: "#fef3c7", badgeText: "#b45309" },
  option: { label: "方案", badgeBg: "#e0f2fe", badgeText: "#0369a1" },
  task: { label: "任务", badgeBg: "#f1f5f9", badgeText: "#475569" },
  milestone: { label: "里程碑", badgeBg: "#dcfce7", badgeText: "#15803d" }
};
