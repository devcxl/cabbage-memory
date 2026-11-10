-- Migration 0013: 归一化 v1 迁移数据的 scope/project_id
-- 0011 早期版本把 scope='user'/'local' 映射为 'global'，但保留了 project_id；
-- global 查询按 project_id = '' 过滤，这些记录会永远查不到。

UPDATE memories SET project_id = '' WHERE scope = 'global' AND project_id != '';
UPDATE memories SET scope = 'global' WHERE project_id = '' AND scope = 'project';
