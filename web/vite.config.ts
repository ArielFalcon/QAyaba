import { defineConfig } from "vite";

export default defineConfig({
  root: "public",
  base: "/app/",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
