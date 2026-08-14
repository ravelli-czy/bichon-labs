// api/_purchase_list_pdf.js — arma el PDF de "lista de compra" que se adjunta
// al correo de Alertas de stock / Alertas de insumos de KIT, para que se
// pueda ver sin entrar a la plataforma. Prefijo `_` — no es una Serverless
// Function (mismo motivo que _email.js).
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_W = 595.28, PAGE_H = 841.89; // A4 en puntos
const MARGIN = 40;
const ROW_H = 18;
const HEADER_H = 22;

function money(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-CL');
}

// Recorta un texto para que entre en `maxWidth` puntos con esa fuente/tamaño,
// agregando "…" si no entra completo.
function fitText(font, size, text, maxWidth) {
  text = String(text ?? '');
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(out + '…', size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return out + '…';
}

// columns: [{ key, label, width, align: 'left'|'right', money: bool }]
// rows: array de objetos (run.items)
async function renderPurchaseListPdf({ heading, subheading, generatedAt, estimatedValue, columns, rows }) {
  const doc = await PDFDocument.create();
  const font     = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const drawText = (text, x, yy, opts = {}) => {
    page.drawText(String(text ?? ''), { x, y: yy, size: opts.size || 9, font: opts.bold ? fontBold : font, color: opts.color || rgb(0.1, 0.1, 0.15) });
  };

  // ── Encabezado ─────────────────────────────────────────────────────────
  drawText(heading, MARGIN, y, { size: 16, bold: true });
  y -= 20;
  drawText(subheading, MARGIN, y, { size: 10, color: rgb(0.4, 0.4, 0.48) });
  if (generatedAt) drawText('Generada: ' + generatedAt, PAGE_W - MARGIN - 150, y, { size: 10, color: rgb(0.4, 0.4, 0.48) });
  y -= 16;
  if (estimatedValue != null) {
    drawText('Valor estimado: ' + money(estimatedValue), MARGIN, y, { size: 11, bold: true, color: rgb(0.05, 0.5, 0.35) });
    y -= 18;
  }
  y -= 6;

  const tableX = MARGIN;
  const totalW = columns.reduce((s, c) => s + c.width, 0);

  const drawHeaderRow = () => {
    page.drawRectangle({ x: tableX, y: y - HEADER_H + 4, width: totalW, height: HEADER_H, color: rgb(0.93, 0.93, 0.97) });
    let x = tableX;
    for (const col of columns) {
      const textX = col.align === 'right' ? x + col.width - fontBold.widthOfTextAtSize(col.label, 9) - 6 : x + 6;
      drawText(col.label, textX, y - HEADER_H + 10, { size: 9, bold: true });
      x += col.width;
    }
    y -= HEADER_H;
  };

  const ensureSpace = neededH => {
    if (y - neededH < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
      drawHeaderRow();
    }
  };

  drawHeaderRow();

  for (const row of rows) {
    ensureSpace(ROW_H);
    let x = tableX;
    for (const col of columns) {
      const raw = col.money ? money(row[col.key]) : row[col.key];
      const text = fitText(font, 9, raw, col.width - 10);
      const textX = col.align === 'right' ? x + col.width - font.widthOfTextAtSize(text, 9) - 6 : x + 6;
      drawText(text, textX, y - ROW_H + 6, { size: 9 });
      x += col.width;
    }
    page.drawLine({ start: { x: tableX, y: y - ROW_H }, end: { x: tableX + totalW, y: y - ROW_H }, thickness: 0.5, color: rgb(0.88, 0.88, 0.92) });
    y -= ROW_H;
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

async function stockAlertPdf(run) {
  return renderPurchaseListPdf({
    heading: 'Alertas de stock — Lista de compra',
    subheading: run.id,
    generatedAt: run.generated_at ? new Date(run.generated_at).toLocaleString('es-CL') : '',
    estimatedValue: run.estimated_value,
    columns: [
      { key: 'name',       label: 'Producto', width: 190 },
      { key: 'sku',        label: 'SKU',       width: 75 },
      { key: 'local_name', label: 'Tienda',    width: 90 },
      { key: 'stock',      label: 'Stock',     width: 50, align: 'right' },
      { key: 'threshold',  label: 'Alerta',    width: 50, align: 'right' },
      { key: 'cost',       label: 'Costo',     width: 60, align: 'right', money: true },
    ],
    rows: run.items || [],
  });
}

async function kitShortageAlertPdf(run) {
  return renderPurchaseListPdf({
    heading: 'Alertas de insumos de KIT — Lista de compra',
    subheading: run.id,
    generatedAt: run.generated_at ? new Date(run.generated_at).toLocaleString('es-CL') : '',
    estimatedValue: run.estimated_value,
    columns: [
      { key: 'name',       label: 'Insumo',    width: 175 },
      { key: 'sku',        label: 'SKU',       width: 70 },
      { key: 'local_name', label: 'Tienda',    width: 85 },
      { key: 'needed',     label: 'Necesario', width: 60, align: 'right' },
      { key: 'stock',      label: 'Stock',     width: 45, align: 'right' },
      { key: 'missing',    label: 'Falta',     width: 45, align: 'right' },
      { key: 'cost',       label: 'Costo',     width: 55, align: 'right', money: true },
    ],
    rows: run.items || [],
  });
}

async function priceAlertPdf(run) {
  return renderPurchaseListPdf({
    heading: 'Alertas de precio — Margen bajo',
    subheading: `${run.id} · Margen promedio: ${Number(run.avg_margin_pct || 0).toFixed(1)}% (esperado ${Number(run.margin_threshold_pct || 0)}%)`,
    generatedAt: run.generated_at ? new Date(run.generated_at).toLocaleString('es-CL') : '',
    estimatedValue: null,
    columns: [
      { key: 'name',       label: 'Producto', width: 185 },
      { key: 'sku',        label: 'SKU',       width: 80 },
      { key: 'tipo',       label: 'Tipo',      width: 60 },
      { key: 'price',      label: 'Precio',    width: 65, align: 'right', money: true },
      { key: 'cost',       label: 'Costo',     width: 65, align: 'right', money: true },
      { key: 'margin_pct', label: 'Margen',    width: 60, align: 'right' },
    ],
    rows: (run.items || []).map(it => ({
      ...it,
      tipo: it.tipo === 'kit' ? 'KIT' : 'Producto',
      margin_pct: Number(it.margin_pct).toFixed(1) + '%',
    })),
  });
}

module.exports = { stockAlertPdf, kitShortageAlertPdf, priceAlertPdf };
