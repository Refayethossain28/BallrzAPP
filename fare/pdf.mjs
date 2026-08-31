/**
 * fare/pdf.mjs — a professional A4 invoice as a real PDF, from scratch.
 *
 * Zero dependencies: this writes the PDF object graph by hand (Helvetica +
 * Helvetica-Bold in WinAnsiEncoding, uncompressed content streams so tests
 * can assert on the text, optional JPEG logo embedded via DCTDecode).
 * Pure: invoicePdf(invoiceRecord, { logoDataUrl }) → Buffer. No clock, no
 * filesystem — everything rendered comes from the invoice's frozen snapshot.
 */
import E from './engine-node.mjs';

/* ── A4 geometry (points) ── */
const W = 595.28, H = 841.89, MARGIN = 48;
const INNER = W - MARGIN * 2;

/* ── palette ── */
const INK = [0.10, 0.12, 0.16];      // near-black text
const MUTED = [0.42, 0.45, 0.50];    // secondary text
const ACCENT = [0.72, 0.58, 0.16];   // understated gold
const RULE = [0.85, 0.86, 0.88];     // hairlines
const PANEL = [0.965, 0.965, 0.955]; // totals panel fill

/* ── text handling: WinAnsi-safe, escaped, width-measurable ── */

// Smart punctuation → WinAnsi-safe equivalents; anything else non-Latin-1 → ''.
function sanitize(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/→/g, '->').replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '');
}

function esc(s) { return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }

// Approximate Helvetica metrics (1/1000 em) — exact for digits/£/., which is
// what right-aligned money columns need; close enough elsewhere.
const NARROW = new Set(" .,:;!'|()[]/ijltf".split(''));
const MID = new Set('r-"'.split(''));
const WIDE = new Set('mwMW@'.split(''));
function charW(c) {
  if (c >= '0' && c <= '9') return 556;
  if (c === '£') return 556;
  if (NARROW.has(c)) return 278;
  if (MID.has(c)) return 333;
  if (WIDE.has(c)) return 889;
  if (c >= 'A' && c <= 'Z') return 690;
  return 520;
}
function textWidth(s, size) {
  let w = 0;
  for (const c of s) w += charW(c);
  return (w / 1000) * size;
}
function truncate(s, size, maxW) {
  if (textWidth(s, size) <= maxW) return s;
  let out = s;
  while (out.length && textWidth(out + '...', size) > maxW) out = out.slice(0, -1);
  return out + '...';
}

/* ── page builder: collects content-stream ops, y measured from the top ── */

class Page {
  constructor() { this.ops = []; this.usesLogo = false; }
  text(x, yTop, str, { size = 9.5, bold = false, color = INK, align = 'left', maxW = 0 } = {}) {
    let s = sanitize(str);
    if (maxW) s = truncate(s, size, maxW);
    if (!s) return;
    if (align === 'right') x -= textWidth(s, size);
    this.ops.push(
      `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color.join(' ')} rg ` +
      `${x.toFixed(2)} ${(H - yTop).toFixed(2)} Td (${esc(s)}) Tj ET`
    );
  }
  hline(x1, x2, yTop, { width = 0.7, color = RULE } = {}) {
    this.ops.push(`${color.join(' ')} RG ${width} w ${x1.toFixed(2)} ${(H - yTop).toFixed(2)} m ${x2.toFixed(2)} ${(H - yTop).toFixed(2)} l S`);
  }
  rect(x, yTop, w, h, color) {
    this.ops.push(`${color.join(' ')} rg ${x.toFixed(2)} ${(H - yTop - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }
  logo(x, yTop, w, h) {
    this.usesLogo = true;
    this.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${(H - yTop - h).toFixed(2)} cm /Logo Do Q`);
  }
  stream() { return this.ops.join('\n'); }
}

/* ── JPEG helpers (logo) ── */

function decodeLogo(dataUrl) {
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  let buf;
  try { buf = Buffer.from(m[1], 'base64'); } catch { return null; }
  if (buf.length < 8 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  // walk segments to a SOF marker for the pixel size
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) return null;
    const marker = buf[i + 1];
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { buf, height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/* ── PDF assembly: pages + fonts (+ logo) → xref'd byte buffer ── */

function assemble(pages, logo) {
  const objs = []; // 1-indexed
  const add = (body) => { objs.push(body); return objs.length; };

  const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  let logoRef = 0;
  if (logo) {
    logoRef = add({
      dict: `<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.buf.length} >>`,
      stream: logo.buf,
    });
  }

  const pageRefs = [];
  const pagesRef = objs.length + pages.length * 2 + 1; // reserved after contents+pages
  for (const page of pages) {
    const content = Buffer.from(page.stream(), 'latin1');
    const contentRef = add({ dict: `<< /Length ${content.length} >>`, stream: content });
    const xobj = page.usesLogo && logoRef ? ` /XObject << /Logo ${logoRef} 0 R >>` : '';
    pageRefs.push(add(
      `<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${W} ${H}] ` +
      `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >>${xobj} >> ` +
      `/Contents ${contentRef} 0 R >>`
    ));
  }
  add(`<< /Type /Pages /Kids [${pageRefs.map((r) => r + ' 0 R').join(' ')}] /Count ${pageRefs.length} >>`);
  const catalogRef = add(`<< /Type /Catalog /Pages ${pagesRef} 0 R >>`);

  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [0];
  let pos = chunks[0].length;
  objs.forEach((o, i) => {
    offsets.push(pos);
    let body;
    if (typeof o === 'string') body = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
    else body = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, 'latin1'),
      Buffer.isBuffer(o.stream) ? o.stream : Buffer.from(o.stream, 'latin1'),
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ]);
    chunks.push(body);
    pos += body.length;
  });
  const xrefPos = pos;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogRef} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

/* ── the invoice layout ── */

const money = (p) => E.formatMoney(p);

export function invoicePdf(inv, { logoDataUrl } = {}) {
  const snap = inv.snapshot || {};
  const biz = snap.business || {};
  const client = snap.client || {};
  const bank = snap.bank || {};
  const lines = snap.lines || [];
  const logo = decodeLogo(logoDataUrl);

  const pages = [];
  let page = new Page();
  pages.push(page);
  let y = MARGIN + 8;
  const AMOUNT_X = W - MARGIN;          // right edge for money
  const DETAIL_X = MARGIN + 78;         // details column
  const DETAIL_W = AMOUNT_X - DETAIL_X - 80;
  const BOTTOM = H - MARGIN - 20;

  const newPage = () => {
    page = new Page();
    pages.push(page);
    y = MARGIN + 6;
    page.text(MARGIN, y, `${biz.name || 'Invoice'}`, { size: 9, bold: true, color: MUTED });
    page.text(AMOUNT_X, y, `Invoice ${inv.displayNumber} - continued`, { size: 9, color: MUTED, align: 'right' });
    y += 14;
    page.hline(MARGIN, W - MARGIN, y); y += 18;
    tableHead();
  };
  const ensure = (needed) => { if (y + needed > BOTTOM) newPage(); };

  const tableHead = () => {
    page.text(MARGIN, y, 'DATE', { size: 8, bold: true, color: MUTED });
    page.text(DETAIL_X, y, 'DETAILS', { size: 8, bold: true, color: MUTED });
    page.text(AMOUNT_X, y, 'AMOUNT', { size: 8, bold: true, color: MUTED, align: 'right' });
    y += 8;
    page.hline(MARGIN, W - MARGIN, y, { width: 1, color: [0.2, 0.22, 0.26] });
    y += 16;
  };

  /* ── header: business identity (left) + logo (right) ── */
  if (logo) {
    const maxW = 120, maxH = 48;
    const scale = Math.min(maxW / logo.width, maxH / logo.height, 1);
    page.logo(W - MARGIN - logo.width * scale, y, logo.width * scale, logo.height * scale);
  }
  page.text(MARGIN, y + 14, biz.name || 'Your Business Name', { size: 19, bold: true });
  y += 26;
  const bizLines = [];
  if (biz.ownerName && biz.ownerName !== biz.name) bizLines.push(biz.ownerName);
  for (const l of String(biz.address || '').split('\n')) if (l.trim()) bizLines.push(l.trim());
  const contact = [biz.phone, biz.email].filter(Boolean).join('  ·  ');
  if (contact) bizLines.push(contact);
  if (biz.vatNumber) bizLines.push(`VAT No. ${biz.vatNumber}`);
  for (const l of bizLines) { page.text(MARGIN, y, l, { size: 9, color: MUTED }); y += 12; }

  y = Math.max(y, MARGIN + 62) + 14;
  page.hline(MARGIN, W - MARGIN, y, { width: 1.4, color: ACCENT });
  y += 26;

  /* ── INVOICE banner + meta grid ── */
  page.text(MARGIN, y + 6, 'INVOICE', { size: 22, bold: true, color: ACCENT });
  const metaX = W - MARGIN - 190;
  const meta = [
    ['Invoice no.', inv.displayNumber],
    ['Issue date', E.formatDateLong(inv.issueDate)],
    ['Due date', E.formatDateLong(inv.dueDate)],
    ['Period', E.monthLabel(inv.period)],
  ];
  let my = y - 6;
  for (const [k, v] of meta) {
    page.text(metaX, my, k, { size: 9, color: MUTED });
    page.text(AMOUNT_X, my, v, { size: 9, bold: true, align: 'right' });
    my += 13;
  }
  y += 22;

  /* ── bill to ── */
  page.text(MARGIN, y, 'BILLED TO', { size: 8, bold: true, color: MUTED });
  y += 13;
  page.text(MARGIN, y, client.name || '', { size: 11, bold: true });
  y += 13;
  for (const l of String(client.address || '').split('\n')) {
    if (!l.trim()) continue;
    page.text(MARGIN, y, l.trim(), { size: 9, color: MUTED }); y += 11;
  }
  if (client.email) { page.text(MARGIN, y, client.email, { size: 9, color: MUTED }); y += 11; }
  y = Math.max(y, my) + 16;

  /* ── job table ── */
  tableHead();
  for (const l of lines) {
    const subRows = (l.waitCharge > 0 ? 1 : 0) + (l.extras || []).length;
    ensure(16 + subRows * 12 + 8);
    page.text(MARGIN, y, E.formatDayLabel(l.date) + (l.time ? ' ' + l.time : ''), { size: 9 });
    const route = l.pickup && l.dropoff ? `${l.pickup} - ${l.dropoff}` : (l.pickup || l.dropoff || 'Journey');
    page.text(DETAIL_X, y, route, { size: 9.5, maxW: DETAIL_W });
    page.text(AMOUNT_X, y, money(l.fare), { size: 9.5, align: 'right' });
    y += 13;
    if (l.waitCharge > 0) {
      page.text(DETAIL_X + 10, y, `Waiting time - ${l.waitMinutes} min @ ${money(l.waitRate)}/hr`, { size: 8.5, color: MUTED, maxW: DETAIL_W });
      page.text(AMOUNT_X, y, money(l.waitCharge), { size: 8.5, color: MUTED, align: 'right' });
      y += 12;
    }
    for (const e of l.extras || []) {
      page.text(DETAIL_X + 10, y, e.label, { size: 8.5, color: MUTED, maxW: DETAIL_W });
      page.text(AMOUNT_X, y, money(e.amount), { size: 8.5, color: MUTED, align: 'right' });
      y += 12;
    }
    y += 3;
    page.hline(MARGIN, W - MARGIN, y); y += 12;
  }

  /* ── totals panel ── */
  const panelRows = inv.vatAmount > 0 ? 3 : 2;
  const panelH = panelRows * 16 + 18;
  ensure(panelH + 10);
  const panelX = W - MARGIN - 230;
  page.rect(panelX, y - 4, 230, panelH, PANEL);
  let ty = y + 10;
  page.text(panelX + 14, ty, 'Subtotal', { size: 9.5, color: MUTED });
  page.text(AMOUNT_X - 14, ty, money(inv.subtotal), { size: 9.5, align: 'right' });
  ty += 16;
  if (inv.vatAmount > 0) {
    page.text(panelX + 14, ty, `VAT @ ${inv.vatRatePct}%`, { size: 9.5, color: MUTED });
    page.text(AMOUNT_X - 14, ty, money(inv.vatAmount), { size: 9.5, align: 'right' });
    ty += 16;
  }
  page.text(panelX + 14, ty, 'Total due', { size: 11.5, bold: true });
  page.text(AMOUNT_X - 14, ty, money(inv.total), { size: 11.5, bold: true, align: 'right' });
  y += panelH + 22;

  /* ── payment footer ── */
  const bankRows = [
    bank.accountName ? ['Account name', bank.accountName] : null,
    bank.sortCode ? ['Sort code', bank.sortCode] : null,
    bank.accountNumber ? ['Account no.', bank.accountNumber] : null,
    bank.bankName ? ['Bank', bank.bankName] : null,
  ].filter(Boolean);
  const footH = 30 + bankRows.length * 12 + (snap.footerNote ? 24 : 0);
  ensure(footH);
  page.hline(MARGIN, W - MARGIN, y, { width: 1.4, color: ACCENT });
  y += 16;
  page.text(MARGIN, y, 'PAYMENT', { size: 8, bold: true, color: MUTED });
  const termsDays = inv.termsDays ?? snap.termsDays;
  page.text(AMOUNT_X, y,
    termsDays != null
      ? `Payment due within ${termsDays} days - by ${E.formatDateLong(inv.dueDate)}`
      : `Payment due by ${E.formatDateLong(inv.dueDate)}`,
    { size: 9, align: 'right', color: MUTED });
  y += 14;
  for (const [k, v] of bankRows) {
    page.text(MARGIN, y, k, { size: 9, color: MUTED });
    page.text(MARGIN + 95, y, v, { size: 9, bold: true });
    y += 12;
  }
  if (snap.footerNote) { y += 8; page.text(MARGIN, y, snap.footerNote, { size: 8.5, color: MUTED, maxW: INNER }); }

  return assemble(pages, logo);
}
