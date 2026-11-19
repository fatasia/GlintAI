import { spawnSync } from "node:child_process";

/** Small two-sheet XLSX generated locally without external packages. */
export function createWorkbook(file: string, uncalculatedFormula = false) {
  const source = `import sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('xl/workbook.xml','<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="一季度" r:id="r1"/><sheet name="二季度" r:id="r2"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>')
 for i in (1,2):
  value='<f>1+1</f>' if sys.argv[2]=='1' and i==1 else '<v>%d</v>'%(i*10)
  z.writestr('xl/worksheets/sheet%d.xml'%i,'<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>项目</t></is></c><c r="B1" t="inlineStr"><is><t>数值</t></is></c></row><row><c r="A2" t="inlineStr"><is><t>季度%d</t></is></c><c r="B2">%s</c></row></sheetData></worksheet>'%(i,value))
`;
  const result = spawnSync("python", ["-I", "-c", source, file, uncalculatedFormula ? "1" : "0"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
}

/** XLSX with early-1900 dates, datetime, a cached string and booleans. */
export function createTypedWorkbook(file: string, use1904 = false) {
  const source = `import sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('xl/workbook.xml','<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="%s"/><sheets><sheet name="类型" r:id="r1"/></sheets></workbook>'%sys.argv[2])
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>')
 z.writestr('xl/styles.xml','<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>')
 z.writestr('xl/worksheets/sheet1.xml','<worksheet><sheetData><row><c r="A1" s="1"><v>1</v></c><c r="B1" s="1"><v>59</v></c><c r="C1" s="1"><v>60</v></c><c r="D1" s="1"><v>61.5</v></c></row><row><c r="A2" t="b"><v>1</v></c><c r="B2" t="b"><v>0</v></c><c r="C2" t="str" s="1"><f>TEXT(1)</f><v>label</v></c></row></sheetData></worksheet>')
`;
  const result = spawnSync("python", ["-I", "-c", source, file, use1904 ? "1" : "0"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
}
