/**
 * 2026-05-08 (§4.4 of root-cause-analysis): safe helpers for raw-SQL
 * patterns that drizzle's sql tag doesn't support natively.
 *
 * Background: drizzle's sql tag binds JS arrays as separate $N parameters
 * (so `sql\`...IN ${arr}\`` becomes `IN ($1, $2, $3, ...)` — that part is
 * fine), BUT for patterns like `ANY(${arr}::int[])` it produces
 * `ANY(($1, $2, $3, ...)::int[])` which Postgres rejects as a row-to-array
 * cast. This bug bit twice on 2026-05-08 (Track A revert endpoint and the
 * valueDetection DISTINCT ON query).
 *
 * Use these helpers whenever raw SQL needs to interpolate an integer list.
 * For drizzle-typed query builder calls, use the native `inArray()` —
 * that path special-cases arrays correctly.
 */

import { sql, type SQL } from "drizzle-orm";

/**
 * Render a JS number[] as a literal `1,2,3` SQL fragment (no surrounding
 * parens). Validates every element is an integer to prevent injection
 * (the values are interpolated literally, not parameterised). Throws on
 * empty input — callers should branch on `ids.length === 0` and skip the
 * query, since `IN ()` is a syntax error in Postgres.
 *
 * Usage:
 *   sql`SELECT * FROM t WHERE id IN (${sqlIntList(ids)})`
 *   sql`SELECT * FROM t WHERE id = ANY(ARRAY[${sqlIntList(ids)}]::int[])`
 *
 * Both produce single-parameter, scan-friendly queries. The integer list
 * itself is inlined into the query text.
 */
export function sqlIntList(ids: number[]): SQL {
  if (ids.length === 0) {
    throw new Error("sqlIntList called with empty array — caller must branch on length first");
  }
  for (const id of ids) {
    if (!Number.isInteger(id)) {
      throw new Error(`sqlIntList expects integers, got ${typeof id}: ${id}`);
    }
  }
  return sql.raw(ids.join(","));
}

/**
 * Render a JS string[] as a literal `'a','b','c'` SQL fragment. Each value
 * is single-quoted with embedded single-quotes escaped. Use sparingly —
 * prefer parameter binding via drizzle's native query builder when
 * possible. Only use this when raw SQL syntax (DISTINCT ON, window
 * functions, etc.) prevents the builder approach.
 */
export function sqlTextList(values: string[]): SQL {
  if (values.length === 0) {
    throw new Error("sqlTextList called with empty array — caller must branch on length first");
  }
  const escaped = values.map((v) => {
    if (typeof v !== "string") {
      throw new Error(`sqlTextList expects strings, got ${typeof v}: ${String(v)}`);
    }
    return `'${v.replace(/'/g, "''")}'`;
  });
  return sql.raw(escaped.join(","));
}
