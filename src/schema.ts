import schemaSql from "../migrations/0001_init.sql";

let schemaPromise: Promise<void> | undefined;

export function ensureSchema(db: D1Database): Promise<void> {
  if (schemaPromise) return schemaPromise;

  const promise = db.exec(schemaSql).then(() => undefined);
  schemaPromise = promise;
  void promise.catch(() => {
    if (schemaPromise === promise) schemaPromise = undefined;
  });
  return promise;
}
