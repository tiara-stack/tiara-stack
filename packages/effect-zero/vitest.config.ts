import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
  },
});
