/*
 * 测试入口： node tests/run.mjs
 * 零依赖，不需要浏览器，不需要手柄。
 */
import testReport from "./test-dualsense-report.mjs";
import testLpDualsense from "./test-lp-dualsense.mjs";
import testAdapter from "./test-ds5-adapter.mjs";
import testPage from "./test-page-wiring.mjs";
import testTripoCache from "./test-tripo-cache.mjs";

const suites = [
  ["test-dualsense-report", testReport],
  ["test-lp-dualsense", testLpDualsense],
  ["test-ds5-adapter", testAdapter],
  ["test-page-wiring", testPage],
  /* 这一套会真起一个服务器（隔离目录 + mock 模式），比其余几套慢，放最后跑 */
  ["test-tripo-cache", testTripoCache]
];

let pass = 0;
let fail = 0;
const failures = [];

for (const [name, fn] of suites) {
  let s;
  try {
    s = await fn();
  } catch (e) {
    console.log(`\n✗ ${name} 直接抛异常：`);
    console.log(e && e.stack ? e.stack : e);
    fail++;
    failures.push(name);
    continue;
  }
  console.log(`\n${s.results.fail === 0 ? "✓" : "✗"} ${s.results.name}  (${s.results.pass}/${s.results.pass + s.results.fail})`);
  console.log(s.results.lines.join("\n"));
  pass += s.results.pass;
  fail += s.results.fail;
  if (s.results.fail) failures.push(name);
}

console.log("\n" + "=".repeat(56));
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail) {
  console.log("失败的套件：" + failures.join(", "));
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
