import { spawn } from "node:child_process";
import type { SourceAdapter } from "./source";
import { fileURLToPath } from "node:url";

/** Trusted local adapter: stdin is JSON {extension, base64}; stdout must be UTF-8 text. */
export function commandSourceAdapter(command: string, args: string[] = []): SourceAdapter {
  if (!command.trim() || args.some((arg) => typeof arg !== "string")) throw new Error("Invalid adapter command");
  return ({ bytes, extension, signal }) => new Promise<string>((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], signal });
    const chunks: Buffer[] = []; let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) { child.kill(); reject(new Error("Adapter output exceeds 10 MiB")); }
      else chunks.push(chunk);
    });
    child.stderr.on("data", () => {}); // Adapter diagnostics may contain source text or secrets.
    child.once("error", reject);
    child.stdin.on("error", () => {});
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error("Source adapter failed; check the installed tool and format"));
      try { resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { reject(new Error("Adapter output must be UTF-8")); }
    });
    child.stdin.end(JSON.stringify({ extension, base64: Buffer.from(bytes).toString("base64") }));
  });
}

// Python stdlib only. No archive extraction, macros, external relationships or formulas are executed.
const OFFICE_SCRIPT = String.raw`
import sys,json,base64,io,zipfile,re,posixpath
import xml.etree.ElementTree as E
x=json.load(sys.stdin); ext=x['extension']; z=zipfile.ZipFile(io.BytesIO(base64.b64decode(x['base64'])))
entries=z.infolist()
if len(entries)>2000 or sum(i.file_size for i in entries)>32*1024*1024: raise ValueError('Archive too large')
if any(i.file_size>10*1024*1024 or '..' in i.filename.split('/') for i in entries): raise ValueError('Unsafe archive')
def xml(name):
 b=z.read(name)
 if b'<!DOCTYPE' in b.upper() or b'<!ENTITY' in b.upper(): raise ValueError('Unsupported XML')
 return E.fromstring(b)
def local(e): return e.tag.rsplit('}',1)[-1]
def texts(e): return ''.join(n.text or '' for n in e.iter() if local(n)=='t')
out=[]
if ext=='docx':
 for p in xml('word/document.xml').iter():
  if local(p)!='p': continue
  text=texts(p)
  if not text.strip(): continue
  style=next((n for n in p.iter() if local(n)=='pStyle'),None)
  val=next(iter(style.attrib.values()),'') if style is not None else ''
  level=re.search(r'(?:Heading|标题)\s*([1-6])',val,re.I)
  out.append(('#'*min(2,int(level[1]))+' ' if level else '')+text)
elif ext=='pptx':
 out.append('# 演示文稿')
 files=sorted((n for n in z.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml',n)),key=lambda n:int(re.search(r'(\d+)\.xml',n)[1]))
 for i,n in enumerate(files):
  paragraphs=[texts(p) for p in xml(n).iter() if local(p)=='p' and texts(p).strip()]
  out.append('## '+(paragraphs[0] if paragraphs else 'Slide '+str(i+1)))
  out.extend(paragraphs[1:])
elif ext=='xlsx':
 out.append('# 工作簿')
 shared=[texts(n) for n in xml('xl/sharedStrings.xml') if local(n)=='si'] if 'xl/sharedStrings.xml' in z.namelist() else []
 rels={n.attrib.get('Id'):n.attrib.get('Target') for n in xml('xl/_rels/workbook.xml.rels') if n.attrib.get('TargetMode')!='External'}
 for sheet in xml('xl/workbook.xml').iter():
  if local(sheet)!='sheet': continue
  rid=next((v for k,v in sheet.attrib.items() if k.endswith('}id')),None)
  target=rels.get(rid)
  if not target: continue
  name=posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/'+target)
  if not name.startswith('xl/worksheets/'): continue
  out.append('## '+sheet.attrib.get('name','Sheet'))
  for row in xml(name).iter():
   if local(row)!='row': continue
   cells=[]
   for cell in row:
    if local(cell)!='c': continue
    value=next((n.text or '' for n in cell if local(n)=='v'),'')
    kind=cell.attrib.get('t')
    if kind=='s': value=shared[int(value)] if value and 0<=int(value)<len(shared) else ''
    elif kind=='inlineStr': value=texts(cell)
    cells.append(cell.attrib.get('r','?')+': '+value)
   if cells: out.append(' | '.join(cells))
else: raise ValueError('Unsupported Office format')
result='\n\n'.join(out)
if len(result.encode('utf8'))>10*1024*1024: raise ValueError('Output too large')
sys.stdout.buffer.write(result.encode('utf8'))
`;
/** Opt-in basic text extraction. Python 3 must be installed; layout and embedded media are omitted. */
export function officeSourceAdapters(python = "python"): Record<string, SourceAdapter> {
  const adapter = commandSourceAdapter(python, ["-I", "-c", OFFICE_SCRIPT]);
  return { docx: adapter, pptx: adapter, xlsx: adapter };
}

export function mediaSourceAdapters(options: { python: string; modelDir?: string }): Record<string, SourceAdapter> {
  const adapter=commandSourceAdapter(options.python,["-I","-X","utf8",fileURLToPath(new URL("../adapters/local_media.py",import.meta.url)),...(options.modelDir?["--model",options.modelDir]:[])]);
  return Object.fromEntries(["png","jpg","jpeg","webp","gif",...(options.modelDir?["wav","mp3","mp4","m4a","mov","webm","ogg"]:[])].map(ext=>[ext,adapter]));
}
