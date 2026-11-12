import { describe, expect, it, vi } from "vitest";

async function schemaModule() {
  vi.resetModules();
  return import("../src/schema");
}

function database(batch: ReturnType<typeof vi.fn>) {
  const prepare = vi.fn((sql: string) => ({ sql }));
  return {
    db: { prepare, batch } as unknown as D1Database,
    prepare,
  };
}

describe("ensureSchema", () => {
  it("prepares every schema statement and batches them once per isolate", async () => {
    const { ensureSchema } = await schemaModule();
    const batch = vi.fn().mockResolvedValue([]);
    const { db, prepare } = database(batch);

    await ensureSchema(db);
    await ensureSchema(db);

    expect(prepare).toHaveBeenCalledTimes(11);
    expect(batch).toHaveBeenCalledTimes(1);
    for (const [sql] of prepare.mock.calls) {
      expect(sql).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS/);
      expect(sql).not.toContain(";");
    }
  });

  it("retries with a fresh promise after initialization fails", async () => {
    const { ensureSchema } = await schemaModule();
    const batch = vi.fn()
      .mockRejectedValueOnce(new Error("D1 unavailable"))
      .mockResolvedValueOnce([]);
    const { db } = database(batch);

    await expect(ensureSchema(db)).rejects.toThrow("D1 unavailable");
    await expect(ensureSchema(db)).resolves.toBeUndefined();
    expect(batch).toHaveBeenCalledTimes(2);
  });
});
