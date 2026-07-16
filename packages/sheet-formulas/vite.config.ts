import { fileURLToPath } from "url";
import { Rolldown } from "vite-plus";
import { appsScript } from "tooling-config/vite";

const bigIntRewrite = (): Rolldown.Plugin => ({
  name: "bigIntRewrite",
  transform(code, id) {
    if (id.endsWith(".js") || id.endsWith(".ts")) {
      return code.replace(/(^|\W)(\d+)n/g, "$1BigInt($2)");
    }
    return code;
  },
});

export default appsScript({
  pack: {
    entry: { index: fileURLToPath(new URL("src/index.ts", import.meta.url)) },
    format: "umd",
    outputOptions: { name: "sheetFormulas" },
    target: "es6",
    minify: true,
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^.*$/],
    },
    plugins: [bigIntRewrite()],
  },
});
