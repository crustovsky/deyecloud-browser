// Tiny key/value helpers over the meta table.

export async function getMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function getMetaJson<T>(db: D1Database, key: string): Promise<T | null> {
  const v = await getMeta(db, key);
  if (v == null) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

export async function setMeta(db: D1Database, key: string, value: unknown): Promise<void> {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  await db
    .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, text)
    .run();
}

export async function deleteMeta(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM meta WHERE key = ?").bind(key).run();
}

export async function allMeta(db: D1Database): Promise<Record<string, string>> {
  const { results } = await db.prepare("SELECT key, value FROM meta").all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}
