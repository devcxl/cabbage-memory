import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration0011 = readFileSync(
  new URL("../migrations/0011_migrate_data.sql", import.meta.url),
  "utf8",
);
const migration0013 = readFileSync(
  new URL("../migrations/0013_normalize_scope.sql", import.meta.url),
  "utf8",
);

test("C3：0011 迁移把非 project 作用域的 project_id 清空", () => {
  const normalized = migration0011.match(
    /CASE WHEN scope = 'project' THEN COALESCE\(project_id, ''\) ELSE '' END/g,
  );
  assert.equal(normalized?.length, 2);
});

test("C3：0013 归一化存量 global 记录的 project_id", () => {
  assert.match(
    migration0013,
    /UPDATE memories SET project_id = '' WHERE scope = 'global' AND project_id != ''/,
  );
});
