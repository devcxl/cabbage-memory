-- Migration 0011: 旧结构化表 → memories_v2 数据迁移
-- instructions → type='instruction'（subtype=原 type）
-- learnings    → type='fact'（subtype=原 type）
-- dailies      → type='daily'
-- 旧 memories 表的数据已在 0008 全量迁入结构化表，本迁移不重复处理，0012 随旧表一并删除。
-- scope 收敛：'user'/'local' → 'global'，仅 'project' 保留
-- source 映射：manual/imported → 'user'，extracted → 'agent'
-- content_fts 原样搬运（instructions 原本无 FTS，置空），scripts/migrate-v2.ts 会调用
-- /api/reindex 按当前分词器与 embedding 模型全量重建。

-- ============================================================
-- 1. instructions
-- ============================================================
INSERT INTO memories_v2 (id, user_id, type, subtype, title, content, content_fts, scope, project_id, date, tags, source, meta, created_at, updated_at, archived)
SELECT
  id,
  user_id,
  'instruction',
  type,
  title,
  content,
  '',
  CASE WHEN scope = 'project' THEN 'project' ELSE 'global' END,
  CASE WHEN scope = 'project' THEN COALESCE(project_id, '') ELSE '' END,
  '',
  COALESCE(tags, '[]'),
  'user',
  json_object('path_pattern', path_pattern, 'priority', COALESCE(priority, 0)),
  created_at,
  updated_at,
  COALESCE(archived, 0)
FROM instructions;

-- ============================================================
-- 2. learnings
-- ============================================================
INSERT INTO memories_v2 (id, user_id, type, subtype, title, content, content_fts, scope, project_id, date, tags, source, source_ids, meta, created_at, updated_at, archived)
SELECT
  id,
  user_id,
  'fact',
  type,
  title,
  content,
  COALESCE(content_fts, ''),
  CASE WHEN scope = 'project' THEN 'project' ELSE 'global' END,
  CASE WHEN scope = 'project' THEN COALESCE(project_id, '') ELSE '' END,
  '',
  COALESCE(tags, '[]'),
  CASE WHEN source = 'extracted' THEN 'agent' ELSE 'user' END,
  source_ids,
  json_object('confidence', COALESCE(confidence, 1.0)),
  created_at,
  updated_at,
  COALESCE(archived, 0)
FROM learnings;

-- ============================================================
-- 3. dailies
-- ============================================================
INSERT INTO memories_v2 (id, user_id, type, subtype, title, content, content_fts, scope, project_id, date, tags, source, meta, created_at, digested_at, archived)
SELECT
  id,
  user_id,
  'daily',
  '',
  '',
  content,
  COALESCE(content_fts, ''),
  CASE WHEN project_id != '' THEN 'project' ELSE 'global' END,
  COALESCE(project_id, ''),
  date,
  COALESCE(tags, '[]'),
  'agent',
  '{}',
  created_at,
  CASE WHEN COALESCE(extracted, 0) = 1 THEN COALESCE(extracted_at, created_at) ELSE NULL END,
  COALESCE(archived, 0)
FROM dailies;
