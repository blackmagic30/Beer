import { defineConfig } from "vitest/config";

// Keep repository checks reproducible in a clean checkout. Explicit workflow
// or operator values still win, while dotenv cannot silently become a test
// prerequisite through an ignored local file.
process.env.NODE_ENV ??= "test";
process.env.PUBLIC_BASE_URL ??= "http://127.0.0.1:3000";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "legacy/**"],
    testTimeout: 15_000,
  },
});
