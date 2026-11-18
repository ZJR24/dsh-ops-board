// 判据一致性测试：client.js 里手抄的 OPEN_STATUSES 必须与 lib/flow.mjs 那份一致。
//
// 为什么需要这个测试：client.js 是单个 IIFE，会被原样内联进 HTML，运行时**无法**
// import flow.mjs（内联脚本没有模块解析）。所以「哪些状态算未收口」这件事在两边各写了一份：
//   · lib/flow.mjs   的 OPEN_STATUSES  —— 服务端 / 渲染期用
//   · client.js      的 isOpenWbStatus —— 浏览器里判断「这张卡跑完是否收口」用
// 两份一旦漂移，症状是**静默**的：工作台会把一张已经收口的卡记成「未收口」，
// 或者把还没做完的卡记成「已收口」，页面上看起来一切正常，只是结论错了。
//
// 这属于「同一事实存了两份」，只能靠一条断言把它们钉在一起。
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let pass = 0;
let fail = 0;
function ok(cond, label, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${detail ? " — " + detail : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? " — " + detail : ""}`);
  }
}

console.log("[1] lib/flow.mjs 的 OPEN_STATUSES");
const flowSrc = readFileSync(join(root, "scripts/lib/flow.mjs"), "utf8");
const flowMatch = /const OPEN_STATUSES = new Set\(\[([\s\S]*?)\]\)/.exec(flowSrc);
ok(!!flowMatch, "能在 flow.mjs 里找到 OPEN_STATUSES 定义");
if (!flowMatch) {
  console.log("\n找不到定义，测试无法继续（说明源码结构变了，请同步更新本测试）");
  process.exit(1);
}
const flowOpen = [...flowMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
ok(flowOpen.length > 0, "读到非空状态清单", flowOpen.join(", "));

console.log("\n[2] client.js 的 isOpenWbStatus");
const clientSrc = readFileSync(join(root, "scripts/lib/client.js"), "utf8");
const clientMatch = /function isOpenWbStatus\([^)]*\)\s*\{([\s\S]*?)\n  \}/.exec(clientSrc);
ok(!!clientMatch, "能在 client.js 里找到 isOpenWbStatus 定义");
if (!clientMatch) {
  console.log("\n找不到定义，测试无法继续（说明函数被改名或移走，请同步更新本测试）");
  process.exit(1);
}
const body = clientMatch[1];
const arrMatch = /var open = \[([\s\S]*?)\]/.exec(body);
ok(!!arrMatch, "能从函数体里取到状态数组");
const clientOpen = arrMatch ? [...arrMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
ok(clientOpen.length > 0, "读到非空状态清单", clientOpen.join(", "));

console.log("\n[3] 两份清单必须一致");
const onlyFlow = flowOpen.filter((s) => !clientOpen.includes(s));
const onlyClient = clientOpen.filter((s) => !flowOpen.includes(s));
ok(onlyFlow.length === 0, "flow.mjs 有、client.js 漏了的状态", onlyFlow.join(", ") || "无");
ok(onlyClient.length === 0, "client.js 有、flow.mjs 没有的状态", onlyClient.join(", ") || "无");
ok(
  flowOpen.length === clientOpen.length && onlyFlow.length === 0 && onlyClient.length === 0,
  "两份清单完全等价",
  `${flowOpen.length} 项 vs ${clientOpen.length} 项`
);

console.log("\n[4] 判据行为抽查（防止两边都写错成同一份错清单）");
// 这些状态是台账里真实出现过的「已收口」状态，必须**不**在未收口清单里
const mustBeClosed = ["done", "closed", "shipped", "dropped", "archived"];
const wrongClosed = mustBeClosed.filter((s) => flowOpen.includes(s));
ok(wrongClosed.length === 0, "已收口状态没有被误算成未收口", wrongClosed.join(", ") || "无");
// 这些是真实出现过的「未收口」状态，必须在清单里
const mustBeOpen = ["open", "doing", "verify"];
const missingOpen = mustBeOpen.filter((s) => !flowOpen.includes(s));
ok(missingOpen.length === 0, "典型未收口状态都在清单里", missingOpen.join(", ") || "无");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
