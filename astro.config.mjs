import { defineConfig } from "astro/config";

export default defineConfig({
  srcDir: "./site",
  outDir: "./dist",
  output: "static",
  build: { format: "file" },
});
