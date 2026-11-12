import schemaSql from "../migrations/0001_init.sql";

// D1 exec() splits multi-line DDL incorrectly; prepare one statement at a time instead.
// This initial schema uses semicolons only as statement terminators.
const schemaStatements = schemaSql
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

let schemaPromise: Promise<void> | undefined;

export function ensureSchema(db: D1Database): Promise<void> {
  if (schemaPromise) return schemaPromise;

  const promise = db
    .batch(schemaStatements.map((statement) => db.prepare(statement)))
    .then(() => undefined);
  schemaPromise = promise;
  void promise.catch(() => {
    if (schemaPromise === promise) schemaPromise = undefined;
  });
  return promise;
}
