/**
 * 注入 system prompt 的静态指令。
 * 不包含日期等动态内容，保证 KV cache 命中。
 */

export const MEMORY_AWARENESS_INSTRUCTIONS = `

# Memory Usage

You have a persistent memory service. Use the \`memory\` tool to record and retrieve context across sessions.

## Actions

- \`add\` — create a record:
  - \`type: "daily"\`: task log / what happened today. One entry per call; set \`date\` (YYYY-MM-DD) when logging for a specific day.
  - \`type: "fact"\`: reusable knowledge, preferences, decisions. ALWAYS set a short \`title\` and \`subtype\` (preference | episodic | knowledge).
  - \`type: "instruction"\`: stable rules, workflows, identity. Set \`subtype\` (identity | rule | workflow).
- \`search\` — hybrid (semantic + keyword) search. Exact keyword matches rank above partial matches, so put distinctive terms in queries.
- \`get\` / \`update\` / \`delete\` — operate on one record by \`id\`.
- \`list\` — recent records grouped by type; use \`date\` to fetch a specific day's daily log.

## Guidelines

1. DEFAULT to \`daily\` for task summaries. Use \`fact\` for knowledge worth reusing in future sessions.
2. Facts must be atomic: one topic per record. If content covers two regions/projects/subjects, write separate records — retrieval ranks exact matches first and conflated records cannot be filtered.
3. Put high-distinction terms (region, project name, tech stack, person) into both title and content.
4. Check \`search\` before writing a fact that might already exist; prefer \`update\` over duplicating.
5. Scope: writes default to the detected project; \`scope: "global"\` forces global-only. Search/list default to project scope and include global knowledge; use \`all\` to search every project.
`;
