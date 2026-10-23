"""Read cached XLSX values only; no formulas, macros or external links execute."""
import sys, json, zipfile, re, posixpath, datetime, io, csv
import xml.etree.ElementTree as E

with zipfile.ZipFile(sys.argv[1]) as z:
    entries = z.infolist()
    if len(entries) > 2000 or sum(i.file_size for i in entries) > 32 * 1024 * 1024:
        raise ValueError("Workbook exceeds archive limits")
    if any(i.file_size > 10 * 1024 * 1024 or '..' in i.filename.split('/') for i in entries):
        raise ValueError("Unsafe workbook")
    def xml(name):
        b = z.read(name)
        if b'<!DOCTYPE' in b.upper() or b'<!ENTITY' in b.upper():
            raise ValueError("Unsupported XML")
        return E.fromstring(b)
    def local(e): return e.tag.rsplit('}', 1)[-1]
    def texts(e): return ''.join(n.text or '' for n in e.iter() if local(n) == 't')
    shared = [texts(n) for n in xml('xl/sharedStrings.xml')] if 'xl/sharedStrings.xml' in z.namelist() else []
    rels = {n.attrib.get('Id'): n.attrib.get('Target') for n in xml('xl/_rels/workbook.xml.rels') if n.attrib.get('TargetMode') != 'External'}
    book = xml('xl/workbook.xml')
    epoch = datetime.datetime(1904, 1, 1) if any(local(n) == 'workbookPr' and n.attrib.get('date1904') in ('1', 'true') for n in book.iter()) else datetime.datetime(1899, 12, 30)
    formats = {}; styles = []
    if 'xl/styles.xml' in z.namelist():
        style = xml('xl/styles.xml')
        formats = {int(n.attrib['numFmtId']): n.attrib.get('formatCode', '') for n in style.iter() if local(n) == 'numFmt'}
        for node in style:
            if local(node) == 'cellXfs': styles = [int(n.attrib.get('numFmtId', 0)) for n in node]
    def is_date(cell):
        idx = int(cell.attrib.get('s', 0))
        fmt = styles[idx] if idx < len(styles) else 0
        code = re.sub(r'"[^"]*"|\\.|\[[^\]]*\]', '', formats.get(fmt, '')).lower()
        return 14 <= fmt <= 22 or 27 <= fmt <= 36 or 50 <= fmt <= 58 or bool(re.search(r'[yd]', code))
    out = []
    for sheet in book.iter():
        if local(sheet) != 'sheet': continue
        rid = next((v for k, v in sheet.attrib.items() if k.endswith('}id')), None)
        target = rels.get(rid)
        if not target: continue
        name = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
        if not name.startswith('xl/worksheets/'): raise ValueError('Unsafe sheet relationship')
        rows = []
        for node in xml(name).iter():
            if local(node) != 'row': continue
            row = []
            for cell in node:
                if local(cell) != 'c': continue
                ref = re.fullmatch(r'([A-Z]+)\d+', cell.attrib.get('r', ''))
                if not ref: raise ValueError('Missing cell reference')
                col = 0
                for c in ref[1]: col = col * 26 + ord(c) - 64
                if col > 256: raise ValueError('Sheet exceeds 256 columns')
                while len(row) < col: row.append('')
                value = next((n.text or '' for n in cell if local(n) == 'v'), '')
                kind = cell.attrib.get('t')
                if kind == 's': value = shared[int(value)] if value else ''
                elif kind == 'inlineStr': value = texts(cell)
                elif kind in ('e', 'b'): raise ValueError('Error or boolean cell; clean the table first')
                elif value and is_date(cell): value = (epoch + datetime.timedelta(days=float(value))).date().isoformat()
                row[col - 1] = value
            if any(row): rows.append(row)
            if len(rows) > 10001: raise ValueError('Sheet exceeds 10000 rows')
        if rows:
            stream = io.StringIO(); csv.writer(stream, lineterminator='\n').writerows(rows)
            out.append({'name': sheet.attrib.get('name', 'Sheet'), 'text': stream.getvalue()})
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode('utf-8'))
