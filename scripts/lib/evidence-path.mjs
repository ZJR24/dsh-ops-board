// scripts/lib/evidence-path.mjs — 从证据文字里认出「文件路径」。
//
// 证据是人手写的，同一件事的写法五花八门：
//
//   cloudfunctions/dailyUpdate/index.js 的 guard()      ← 现在路径 + 描述
//   src\API\FileTest.java:13 ｜ src\tools\FileCopy.java:14-15   ← 多个路径 + 行号
//   out\production\<项目>\FileCopy.class              ← 反斜杠
//   email-config.properties                             ← 只有文件名
//
// 所以不能只认某几个扩展名（早先只写了 mjs/cjs/json/js/py/wxml/wxss，
// 结果 Java 项目的 .java 一条都认不出来），也不能只取第一个 ——
// 一句话里点了好几个文件是常事，每个都该能点开。
//
// 判据：从字符串的起始边界开始，由路径字符组成，以「点 + 扩展名」收尾。
// 扩展名限 1~10 位字母数字，足够覆盖 .java / .properties / .wxml / .tsx / .kt。

const SEGMENT = /[\w\-./\\]+\.[A-Za-z][A-Za-z0-9]{0,9}/g;

// 这些后缀看着像扩展名其实不是（版本号、比分、时间），挡掉。
const NOT_EXT = new Set([
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
]);

// 「只有文件名」时，得是这些后缀才认 —— 否则 email.username、gmail.com、
// example.org 这类会被当成文件，页面上就多出一堆点开报错的按钮。
// 带目录分隔符的一律认（那已经足够像路径了）。
const CODE_EXT = new Set([
  "mjs", "cjs", "js", "jsx", "ts", "tsx", "json", "jsonc",
  "py", "rb", "go", "rs", "java", "kt", "kts", "scala", "cs", "c", "h", "cpp", "hpp", "cc", "m", "swift", "php",
  "wxml", "wxss", "vue", "svelte", "css", "scss", "less", "html", "htm", "xml", "svg",
  "sh", "bash", "zsh", "ps1", "bat", "cmd", "sql", "graphql", "gql",
  "yml", "yaml", "toml", "ini", "cfg", "conf", "properties", "env",
  "md", "txt", "rst", "log", "csv", "tsv",
  "iml", "gradle", "lock", "pom", "dockerfile", "gitignore", "editorconfig",
  "class", "jar", "war", "wasm", "proto", "tf", "hcl", "lua", "dart", "ex", "exs", "erl", "clj",
]);

/**
 * 找出文字里所有像文件路径的片段。
 *
 * @param {string} text
 * @returns {{path:string, at:number, raw:string}[]} 按出现顺序，互不重叠
 */
export function pathsIn(text) {
  const s = String(text || "");
  const out = [];
  let last = -1;
  SEGMENT.lastIndex = 0;
  for (const m of s.matchAll(SEGMENT)) {
    const raw = m[0];
    const at = m.index;
    if (at < last) continue;              // 已被前一个更长匹配吃掉
    const ext = raw.slice(raw.lastIndexOf(".") + 1).toLowerCase();
    if (NOT_EXT.has(ext)) continue;       // 1.2.3 这种不是文件
    // 首字符不能是分隔符：`/api/x` 里的 `/api` 不是相对路径的开头
    const path = raw.replace(/^[./\\]+/, "");
    if (!path || path.indexOf(".") < 1) continue;
    // 没有目录分隔符时，后缀得是认识的那种，否则多半是域名/属性名。
    const hasDir = /[/\\]/.test(path.slice(0, path.lastIndexOf(".")));
    if (!hasDir && !CODE_EXT.has(ext)) continue;
    out.push({ path, at, raw });
    last = at + raw.length;
  }
  return out;
}

/** 只要第一个路径，认不出就返回空串。 */
export function firstPath(text) {
  const all = pathsIn(text);
  return all.length ? all[0].path : "";
}
