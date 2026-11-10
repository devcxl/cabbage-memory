import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../../../.github/workflows/pr-review.yml", import.meta.url),
  "utf8",
);

test("H9：PR 审查 action 固定到不可变 SHA，且不含浮动 main 引用", () => {
  assert.doesNotMatch(workflow, /agentic-action@main/);
  const refs = [...workflow.matchAll(/agentic-action@([0-9a-f]{40})/g)];
  assert.equal(refs.length, 2);
});

test("H9：PR 审查权限收敛，不授予 issues 写权限", () => {
  assert.doesNotMatch(workflow, /issues:\s*write/);
  assert.match(workflow, /pull-requests:\s*write/);
});

test("H9：fork PR 被 job 级条件跳过，报告回评前做结构校验", () => {
  assert.match(
    workflow,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.match(workflow, /SIZE=.*20000/s);
  assert.match(workflow, /总体结论/);
  assert.match(workflow, /合并前核查清单/);
});
