import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  noExternal: ["@tchain/core"],
  async onSuccess() {
    const webDistSrc = path.resolve(process.cwd(), "../web/dist");
    const webDistDest = path.resolve(process.cwd(), "dist/web");
    if (fs.existsSync(path.join(webDistSrc, "index.html"))) {
      fs.rmSync(webDistDest, { recursive: true, force: true });
      fs.cpSync(webDistSrc, webDistDest, { recursive: true });
    }
  }
});
