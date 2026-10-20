import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { commandSourceAdapter, officeSourceAdapters } from "./adapters";
import { readSourceText } from "./source";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
it("runs a trusted OCR/transcription adapter through stdin with no shell", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-adapter-test-")); dirs.push(dir);
  const file = path.join(dir, "input.png"); await fs.writeFile(file, "binary");
  const adapter = commandSourceAdapter(process.execPath, ["-e", 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write("# OCR\\n"+JSON.parse(s).extension));']);
  expect(await readSourceText({ path: file }, { adapters: { png: adapter } })).toContain("OCR");
  const broken = commandSourceAdapter(process.execPath, ["-e", "process.stderr.write('SECRET');process.exit(1)"]);
  await expect(readSourceText({ path: file }, { adapters: { png: broken } })).rejects.toThrow("adapter failed");
});
const python = spawnSync("python", ["--version"], { windowsHide: true });
it.skipIf(python.status !== 0)("extracts real zipped DOCX, PPTX and XLSX with the opt-in Python adapter", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-office-test-")); dirs.push(dir);
  const script = `import zipfile,sys,os\np=sys.argv[1]\nfiles={'docx':{'word/document.xml':'<document><p><t>中文文档</t></p></document>'},'pptx':{'ppt/slides/slide1.xml':'<slide><p><t>标题</t></p><p><t>幻灯片正文</t></p></slide>'},'xlsx':{'xl/workbook.xml':'<workbook xmlns:r="rel"><sheets><sheet name="数据" r:id="rId1"/></sheets></workbook>','xl/_rels/workbook.xml.rels':'<rels><rel Id="rId1" Target="worksheets/sheet1.xml"/></rels>','xl/worksheets/sheet1.xml':'<worksheet><row><c r="A1" t="inlineStr"><is><t>单元格</t></is></c><c r="B1"><v>42</v></c></row></worksheet>'}}\nfor ext,entries in files.items():\n with zipfile.ZipFile(os.path.join(p,'input.'+ext),'w') as z:\n  for name,xml in entries.items(): z.writestr(name,xml)\n`;
  const made = spawnSync("python", ["-I", "-c", script, dir], { windowsHide: true });
  expect(made.status, made.stderr.toString()).toBe(0);
  const adapters = officeSourceAdapters();
  expect(await readSourceText({ path: path.join(dir, "input.docx") }, { adapters })).toContain("中文文档");
  expect(await readSourceText({ path: path.join(dir, "input.pptx") }, { adapters })).toContain("幻灯片正文");
  const sheet = await readSourceText({ path: path.join(dir, "input.xlsx") }, { adapters });
  expect(sheet).toContain("数据"); expect(sheet).toContain("A1: 单元格 | B1: 42");
});
