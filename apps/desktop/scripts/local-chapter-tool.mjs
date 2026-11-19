import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { chaptersDocument } from "../../web/src/ChaptersStore.ts";
import { openSecureAssets } from "../../web/server/secure-assets-bridge.mjs";
import { exportPortableChapters, preflightPortableChapters, importPortableChapters } from "../../web/server/portable-chapter-migration.ts";

const LIMIT = 32 * 1024 * 1024;
const SNAPSHOT_LIMIT = 2_000_000;
const help = `Glint 本机章节包工具（仅 Windows 本地固定磁盘）

先在章节工作台使用“导出章节 JSON”保存引用文件。默认素材目录为
%APPDATA%\\ai.glint.desktop.dev\\media；若自行更改过数据目录，请使用实际目录。
所有目录须已存在；文件名以 .json 结尾。输出不覆盖已有不同内容。
先在命令提示符进入 Glint-chapters.cmd 所在目录，例如：
cd /d "C:\\Users\\你的用户名\\AppData\\Local\\Glint"

导出：Glint-chapters.cmd export --chapters "引用文件.json" --assets "素材目录" --out "迁移包.json"
预检：Glint-chapters.cmd preview --bundle "迁移包.json" --assets "目标素材目录" [--out "恢复章节.json"]
恢复：Glint-chapters.cmd restore --bundle "迁移包.json" --assets "目标素材目录" --out "恢复章节.json" --confirm 预检显示的摘要

恢复后在目标桌面的章节工作台选择“导入章节 JSON”，选择恢复章节.json 并确认。
需要可信来源的迁移包、素材、FFmpeg 和 ffprobe；HTML 场景及无法完整验证的素材会拒绝迁移。
预检不写入数据；可指定 --out 提前检查输出冲突。确认摘要绑定包内容与目标素材目录，
不绑定输出路径，也不保证目录或素材不被其他进程更改。恢复时会再次检查输出。
恢复失败可能已写入部分不可覆盖的素材，可使用相同命令重试。
请仅在可信的本机账户和目录中使用；本工具与解码器不隔离同一账户下的其他进程。`;

function argsFor(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") return { command: "help" };
  const required = { export: ["chapters", "assets", "out"], preview: ["bundle", "assets"], restore: ["bundle", "assets", "out", "confirm"] }[command];
  if (!required || rest.length % 2 !== 0) throw new Error("参数不完整或包含不支持的参数；运行 help 查看用法。");
  const allowed = command === "preview" ? [...required, "out"] : required;
  const values = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.slice(2);
    if (!rest[i]?.startsWith("--") || !allowed.includes(key) || key in values || !rest[i + 1]) throw new Error("参数无效；运行 help 查看用法。");
    values[key] = rest[i + 1];
  }
  if (required.some(key => !(key in values))) throw new Error("参数不完整；运行 help 查看用法。");
  return { command, ...values };
}
function documentPath(value) {
  if (!/^[a-zA-Z]:[\\/]/.test(value) || !value.endsWith(".json") || value.split(/[\\/]/).some(part => part === "." || part === "..")) throw new Error("请选择不含点路径的本地磁盘绝对 JSON 文件路径。");
  const parsed = path.win32.parse(value);
  if (!parsed.base || parsed.base === ".json") throw new Error("JSON 文件名无效。");
  return { root: parsed.dir, name: parsed.base };
}
function utf8(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("JSON 文件不是有效 UTF-8。"); }
}
function referenceDocument(text) {
  if (Buffer.byteLength(text) > SNAPSHOT_LIMIT) throw new Error("章节引用文件超过 2 MB。");
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error("章节引用文件不是有效 JSON。"); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !isDeepStrictEqual(Object.keys(doc).sort(), ["chapters", "kind", "version"]) || doc.kind !== "glint.chapters.references" || doc.version !== 1 || !Array.isArray(doc.chapters) || !doc.chapters.length) throw new Error("请选择包含章节的 Glint 章节引用 JSON。");
  const parsed = chaptersDocument(doc.chapters);
  if (!isDeepStrictEqual(parsed.chapters, doc.chapters)) throw new Error("章节引用文件含有无法完整恢复的数据。");
  return parsed.chapters;
}
function outputDocument(chapters) {
  const doc = chaptersDocument(chapters);
  if (!isDeepStrictEqual(doc.chapters, chapters)) throw new Error("恢复章节无法完整导入工作台；未发布素材。");
  const text = JSON.stringify(doc, null, 2);
  if (Buffer.byteLength(text) > SNAPSHOT_LIMIT) throw new Error("恢复后的章节引用文件超过 2 MB；未发布素材。");
  return Buffer.from(text);
}
async function checkOutput(store, name, expected) {
  try {
    const existing = await store.read(name);
    if (!existing.equals(expected)) throw new Error("输出文件已存在且内容不同，未覆盖。请选择其他文件名。");
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

export async function runChapterTool(argv, { bridge, write = text => process.stdout.write(text) } = {}) {
  const options = argsFor(argv);
  if (options.command === "help") { write(help + "\n"); return; }
  if (!bridge || !path.win32.isAbsolute(bridge)) throw new Error("本机安全桥未安装或路径无效。");
  if (!/^[a-zA-Z]:[\\/]/.test(options.assets) || options.assets.split(/[\\/]/).some(part => part === "." || part === "..")) throw new Error("素材目录必须是不含点路径的本地磁盘绝对路径。");
  const confirmValid = /^[a-f0-9]{64}$/.test(options.confirm ?? "");
  if (options.command === "restore" && !confirmValid) throw new Error("确认摘要格式无效，请重新预检。");
  const input = documentPath(options.command === "export" ? options.chapters : options.bundle);
  const output = options.out ? documentPath(options.out) : undefined;
  const stores = [];
  const open = async root => { const store = await openSecureAssets(bridge, root); stores.push(store); return store; };
  try {
    const inputStore = await open(input.root);
    const assets = await open(options.assets);
    const inputBytes = await inputStore.read(input.name);
    if (inputBytes.length > LIMIT) throw new Error("输入文件超过 32 MiB。");
    const text = utf8(inputBytes);
    if (options.command === "export") {
      const serialized = await exportPortableChapters(referenceDocument(text), name => assets.read(name));
      // Refuse bundles that cannot later become an exact, importable chapter document.
      const verification = await preflightPortableChapters(serialized, { read: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
      outputDocument(verification.chapters);
      const bundle = Buffer.from(serialized);
      const destination = await open(output.root);
      await checkOutput(destination, output.name, bundle);
      await destination.publish(output.name, bundle);
      write(`导出完成：${options.out}\n包含完整章节快照与已验证素材，请妥善备份。\n`);
      return;
    }
    // Confirmation prevents accidental destination changes; it is not an authentication token.
    const digest = createHash("sha256").update("glint-chapter-confirm-v1\0").update(path.win32.normalize(options.assets)).update("\0").update(inputBytes).digest("hex");
    if (options.command === "restore" && options.confirm !== digest) throw new Error("确认摘要与当前迁移包或目标素材目录不一致，请重新预检。");
    const preview = await preflightPortableChapters(text, assets);
    const resultBytes = outputDocument(preview.chapters);
    if (options.command === "preview") {
      if (output) {
        const destination = await open(output.root);
        await checkOutput(destination, output.name, resultBytes);
      }
      write(`预检通过，未写入数据。章节 ${preview.chapters.length} 个：\n`);
      for (const chapter of preview.chapters) write(`  ${chapter.title}（${chapter.project.id}）\n`);
      write(`目标素材目录：${path.win32.normalize(options.assets)}\n${output ? `已检查输出文件：${options.out}\n` : "未检查输出文件；可使用 --out 提前检查。\n"}确认摘要：${digest}\n请核对目标素材目录后，以此摘要执行 restore。\n`);
      return;
    }
    const destination = await open(output.root);
    await checkOutput(destination, output.name, resultBytes);
    const result = await importPortableChapters(text, assets);
    if (!isDeepStrictEqual(result.chapters, preview.chapters)) throw new Error("恢复结果与预检不同；原包保留，素材可能已写入，请重新预检。");
    await destination.publish(output.name, resultBytes);
    write(`恢复完成：${options.out}\n请在目标桌面章节工作台导入此引用 JSON 并确认；本机章节尚未自动更改。\n`);
  } finally {
    const failures = (await Promise.allSettled(stores.map(store => store.close()))).filter(item => item.status === "rejected");
    if (failures.length) process.stderr.write("本机安全桥关闭失败，请重启工具；已写入的数据不会自动删除。\n");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bridge = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server/glint-secure-assets.exe");
  try { await runChapterTool(process.argv.slice(2), { bridge }); }
  catch (error) { process.stderr.write(`章节操作失败：${error instanceof Error ? error.message : "未知错误"}\n原包未删除；恢复失败可能已写入部分素材，可排除冲突后重试。\n`); process.exitCode = 1; }
}
