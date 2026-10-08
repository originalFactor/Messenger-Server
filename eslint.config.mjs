import { defineConfig, globalIgnores } from "eslint/config";
import next from "eslint-config-next";

export default defineConfig([
  ...next,
  globalIgnores([
    ".next/**",
    "node_modules/**",
    // The compiled Compose Multiplatform web client, unpacked into public/app/
    // by `pnpm web:client`. It is build output (generated JS/WASM plus its
    // .d.ts files), not server source, and linting it only produces bogus
    // findings — e.g. a React hook rule firing on emscripten glue.
    "public/app/**",
  ]),
]);
