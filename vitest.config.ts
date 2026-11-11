import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "sql-text",
      transform(code, id) {
        if (!id.endsWith(".sql")) return;
        return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
});
