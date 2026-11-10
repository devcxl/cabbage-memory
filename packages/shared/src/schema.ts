/**
 * 领域模型 — 与数据库表一一对应（v2 统一 Schema）
 * 这是数据模型的唯一"真相来源"，SQL DDL 和 TS 类型均应与此保持一致。
 */

export const MEMORY_TYPES = ["daily", "fact", "instruction", "digest"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** instruction 的细分：身份 / 规则 / 工作流 */
export const INSTRUCTION_SUBTYPES = ["identity", "rule", "workflow"] as const;
export type InstructionSubtype = (typeof INSTRUCTION_SUBTYPES)[number];

/** fact 的细分：偏好 / 情景 / 知识 */
export const FACT_SUBTYPES = ["preference", "episodic", "knowledge"] as const;
export type FactSubtype = (typeof FACT_SUBTYPES)[number];

/** 查询作用域：project = 当前项目 + 全局；global = 仅全局；all = 全部项目 */
export type MemoryQueryScope = "project" | "global" | "all";

/** 记忆来源：agent（编码代理写入）| user（人工写入）| digest（定时总结产出）| system（系统） */
export const MEMORY_SOURCES = ["agent", "user", "digest", "system"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export type MemoryScope = "global" | "project";

/** 统一记忆记录（memories 表的一行） */
export interface MemoryRecord {
  id: string;
  user_id: string;
  type: MemoryType;
  /** instruction: identity/rule/workflow；fact: preference/episodic/knowledge；其余为空 */
  subtype: string;
  title: string;
  content: string;
  /** FTS 分词后文本（服务端内部字段，列表接口不返回） */
  content_fts?: string;
  scope: MemoryScope;
  project_id: string;
  /** YYYY-MM-DD，daily/digest 有值 */
  date: string;
  /** JSON 序列化的标签数组 */
  tags: string;
  source: MemorySource;
  /** JSON 数组：digest → 当天 daily 的 id 列表 */
  source_ids: string | null;
  /** JSON 扩展字段（confidence、path_pattern 等） */
  meta: string;
  created_at: number;
  updated_at: number | null;
  /** daily 被总结的时间（幂等标记） */
  digested_at: number | null;
  archived: number;
}

/** 记忆分面实体（memory_entities 表） */
export interface MemoryEntity {
  key: string;
  value: string;
}

/** 记忆演化关系（memory_links 表） */
export const LINK_RELATIONS = [
  "supersedes",
  "contradicts",
  "references",
  "derived_from",
] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

export interface MemoryLink {
  from_id: string;
  to_id: string;
  relation: LinkRelation;
  created_at: number;
}

/** 用户（GitHub OAuth 登录） */
export interface User {
  id: string;
  github_id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  created_at: number;
  last_login_at: number | null;
}

/** API Token 的公开视图（不含哈希） */
export interface ApiTokenView {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/** 后台任务执行记录 */
export interface JobRun {
  id: string;
  user_id: string | null;
  job: string;
  status: "running" | "completed" | "failed";
  detail: string | null;
  started_at: number;
  completed_at: number | null;
}
