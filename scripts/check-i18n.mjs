import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dictionary = JSON.parse(readFileSync(join(root, "lib/i18n/en-US.json"), "utf8"));
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
for (const [key, value] of Object.entries(dictionary)) {
  assert.ok(value.trim(), `Empty translation: ${key}`);
  assert.deepEqual(placeholders(value), placeholders(key), `Placeholder mismatch: ${key}`);
}

let callSites = 0;
function checkDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      checkDirectory(file);
    } else if (/\.tsx?$/.test(file)) {
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isCallExpression(node) && node.expression.getText(source) === "t"
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          const key = node.arguments[0].text;
          assert.ok(Object.hasOwn(dictionary, key), `Missing translation in ${file}: ${key}`);
          callSites++;
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
}
for (const directory of ["app", "components", "lib"]) checkDirectory(join(root, directory));

const code = ts.transpileModule(readFileSync(join(root, "lib/i18n/index.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const testModule = { exports: {} };
runInNewContext(code, {
  module: testModule, exports: testModule.exports,
  require(name) {
    assert.equal(name, "./en-US.json");
    return dictionary;
  },
});
const { createTranslator, resolveLocale } = testModule.exports;
const en = createTranslator("en-US");
const zh = createTranslator("zh-CN");
assert.equal(resolveLocale(undefined), "zh-CN");
assert.equal(resolveLocale("fr-FR"), "zh-CN");
assert.equal(resolveLocale("en-US"), "en-US");
assert.equal(en("模型广场"), "Model marketplace");
assert.equal(zh("模型广场"), "模型广场");
assert.equal(en("成功生成 {0} 张卡密", { 0: 0 }), "Generated 0 card codes");
for (const text of ["A user-defined title", "用户自己的标题", "constructor", "__proto__"]) {
  assert.equal(en(text), text);
}
assert.equal(en("{0} 个会话", { 0: "{1}" }), "{1} conversations");
assert.equal(zh("{0} 个会话", { 0: 3 }), "3 个会话");
console.log(`i18n checks passed: ${Object.keys(dictionary).length} translations, ${callSites} literal call sites, placeholders, fallback, and isolated locales.`);
