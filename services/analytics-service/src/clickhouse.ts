// Real ClickHouse over its HTTP interface (brew-installed, verified this
// session) — no client library needed for straightforward INSERT/SELECT.
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";

export async function chQuery(sql: string): Promise<string> {
  const response = await fetch(CLICKHOUSE_URL, { method: "POST", body: sql });
  if (!response.ok) {
    throw new Error(`ClickHouse error ${response.status}: ${await response.text()}`);
  }
  return response.text();
}

export async function chQueryJSON<T>(sql: string): Promise<T[]> {
  const text = await chQuery(sql.trim().replace(/;?$/, "") + " FORMAT JSONEachRow");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
