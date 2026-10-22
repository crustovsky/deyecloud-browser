import { execSync } from "node:child_process";
import { defineConfig } from "astro/config";

// Short commit id stamped into the footer so you can see which build is deployed.
// Workers Builds exposes the sha as an env var; a local build asks git; anything else is "dev".
let version = (process.env.WORKERS_CI_COMMIT_SHA ?? "").slice(0, 7);
if (!version) {
  try {
    version = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    version = "dev";
  }
}

export default defineConfig({
  srcDir: "./site",
  outDir: "./dist",
  output: "static",
  build: { format: "file" },
  vite: { define: { "import.meta.env.BUILD_VERSION": JSON.stringify(version) } },
});
