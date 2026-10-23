import type { Scene } from "@glintai/scenescript";

export interface TableChartResult { scenes: Scene[]; warnings: string[]; rows: number; series: string[] }

const DELIMITERS = [",", "\t", ";", "|"];
const isNumber = (value: string) => value.trim() !== "" && Number.isFinite(Number(value));

/** RFC 4180 cells, including escaped quotes, embedded delimiters and newlines. */
export function parseTable(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const first = source.split(/\r?\n/)[0] ?? "";
  const count = (d: string) => { let quoted = false, n = 0; for (const c of first) { if (c === '"') quoted = !quoted; if (!quoted && c === d) n++; } return n; };
  const delimiter = [...DELIMITERS].sort((a, b) => count(b) - count(a))[0]!;
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"') { if (quoted && source[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === delimiter || c === "\n" || c === "\r")) {
      row.push(cell.trim()); cell = "";
      if (c !== delimiter) { if (row.some(Boolean)) rows.push(row); row = []; if (c === "\r" && source[i + 1] === "\n") i++; }
    } else cell += c;
  }
  if (quoted) throw new Error("CSV 引号未闭合,请检查数据文件");
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
  return rows;
}

/** Only unambiguous calendar formats; never interpret category numbers as dates. */
export function tableDate(value: string): number | undefined {
  const match = /^(\d{4})[-/年](\d{1,2})(?:[-/月](\d{1,2})日?)?月?$/.exec(value.trim());
  if (!match) return undefined;
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3] ?? 1);
  const time = Date.UTC(y, m - 1, d), date = new Date(time);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? time : undefined;
}

/**
 * Turns a small table (CSV/TSV, ≤24 data rows) into chart scenes with no
 * configuration: one label column (first non-numeric), then 1 series →
 * bar; 2 series → combo; a label column plus exactly 2 numeric columns
 * where the first looks like an x-axis quantity → user can still override
 * via kind. Chart type auto-picks from data shape; everything is editable
 * SceneScript afterwards.
 */
export function chartScenesFromTable(text: string, options: { title?: string; kind?: "bar" | "line" | "area" | "pie" | "scatter" | "combo"; id?: string } = {}): TableChartResult {
  const warnings: string[] = [];
  const rows = parseTable(text);
  if (rows.length < 2) throw new Error("表格至少需要表头加一行数据(或两行数据)");
  const width = Math.max(...rows.map(row => row.length));
  rows.forEach(row => { while (row.length < width) row.push(""); });
  if (width < 2) throw new Error("没有找到数值列:第一列作标签,其后至少一列数字;请检查分隔符(支持逗号/制表符/分号/竖线)");
  let header: string[] | undefined;
  let dataRows = rows;
  if (!rows[0]!.slice(1).some(isNumber)) { header = rows[0]!; dataRows = rows.slice(1); }
  if (dataRows.length === 0) throw new Error("表格没有数据行");
  // Label column: column 0 unless most data rows start with a number there —
  // then the label is the first mostly-non-numeric column that has numbers after it.
  const numericIn = (column: number) => dataRows.filter(row => isNumber(row[column]!)).length;
  const seriesAfter = (column: number) => [column + 1, column + 2, column + 3].some(i => i < width && dataRows.some(row => isNumber(row[i]!)));
  const labelColumn = numericIn(0) * 2 >= dataRows.length
    ? ([1, 2, 3].find(column => column < width && numericIn(column) === 0 && seriesAfter(column)) ?? 0)
    : 0;
  const seriesColumns = [0, 1, 2, 3, 4, 5].map(i => labelColumn + 1 + i).filter(i => i < width && dataRows.some(row => isNumber(row[i]!)));
  if (seriesColumns.length === 0) throw new Error("没有找到数值列:第一列作标签,其后每行至少要有一个可解析的数字(数字列含无法解析的内容时同样报此错)");
  const temporal = dataRows.every(row => tableDate(row[labelColumn]!) !== undefined);
  if (temporal) {
    dataRows = [...dataRows].sort((a, b) => tableDate(a[labelColumn]!)! - tableDate(b[labelColumn]!)!);
    warnings.push("已识别日期列,按时间升序排列;缺失日期不插值");
  }
  for (const row of dataRows) for (const column of seriesColumns) if (!isNumber(row[column]!)) throw new Error(`数值列「${header?.[column] ?? column + 1}」包含空值或无法解析的数字`);
  const truncation = dataRows.length - 24;
  if (truncation > 0) { dataRows = dataRows.slice(0, 24); warnings.push(`数据行超过 24,已截断 ${truncation} 行(图表单页上限)`); }
  const labels = dataRows.map(row => row[labelColumn]!.slice(0, 24) || `第${rows.indexOf(row) + 1}行`);
  const seriesName = (column: number, index: number) => header?.[column]?.slice(0, 16) || `系列${index + 1}`;
  const idBase = options.id ?? "chart";
  const kind = options.kind;
  const scenes: Scene[] = [];
  const title = options.title;
  if (seriesColumns.length === 1) {
    const column = seriesColumns[0]!;
    scenes.push({ id: idBase, kind: "chart", chartType: kind ?? (temporal || dataRows.length > 6 ? "line" : "bar"), ...(title ? { heading: title } : {}), ...(header ? { unit: "" } : {}), narration: { text: `通过图表看${title ?? seriesName(column, 0)}的数据变化。` }, data: dataRows.map((row, i) => ({ label: labels[i]!, value: Number(row[column]) })) });
  } else if (seriesColumns.length === 2) {
    scenes.push({ id: idBase, kind: "chart", chartType: kind ?? "combo", ...(title ? { heading: title } : {}), seriesLabel2: seriesName(seriesColumns[1]!, 1), narration: { text: `两组数据放在一起对比更直观。` }, data: dataRows.map((row, i) => ({ label: labels[i]!, value: Number(row[seriesColumns[0]!]), value2: Number(row[seriesColumns[1]!]) })) });
  } else {
    seriesColumns.forEach((column, index) => {
      scenes.push({ id: index === 0 ? idBase : `${idBase}-${index + 1}`, kind: "chart", chartType: kind ?? (temporal || dataRows.length > 6 ? "line" : "bar"), ...(title || header ? { heading: title ?? seriesName(column, index) } : {}), narration: { text: `继续看${seriesName(column, index)}的变化。` }, data: dataRows.map((row, i) => ({ label: labels[i]!, value: Number(row[column]) })) });
    });
    warnings.push(`${seriesColumns.length} 个数值列已拆成 ${scenes.length} 个图表场景`);
  }
  for (const scene of scenes) if (scene.kind === "chart" && scene.data.some(point => !Number.isFinite(point.value))) throw new Error("数值列包含无法解析的数字,请清洗数据后重试");
  return { scenes, warnings, rows: dataRows.length, series: seriesColumns.map((column, index) => seriesName(column, index)) };
}
