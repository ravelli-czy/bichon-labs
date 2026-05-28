// services/notifications/index.js
// Microservicio de Notificaciones.
// Escucha el evento "stock.low" de RabbitMQ y envía:
//   → WhatsApp al proveedor asignado (via Twilio)
//   → Email al administrador (via SendGrid)
//   → Push en app (via endpoint de lectura)

const express = require("express");
const amqp    = require("amqplib");
const fetch   = require("node-fetch");
const app  = express();
app.use(express.json());

const PORT      = process.env.PORT     || 3007;
const SUPPLIERS = process.env.SUPPLIERS_URL || "http://localhost:3005";

// ─── CLIENTES EXTERNOS ─────────────────────────

// Twilio (WhatsApp)
const twilio = process.env.TWILIO_SID
  ? require("twilio")(process.env.TWILIO_SID, process.env.TWILIO_TOKEN)
  : null;
const TWILIO_FROM = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";

// SendGrid (Email)
let sgMail = null;
if (process.env.SENDGRID_API_KEY) {
  sgMail = require("@sendgrid/mail");
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// En-app: cola simple en memoria (en producción usar Redis o WebSockets)
const inAppAlerts = [];

// ─── RABBITMQ ──────────────────────────────────
async function initMQ() {
  const conn = await amqp.connect(process.env.RABBITMQ_URL || "amqp://localhost");
  const mq   = await conn.createChannel();
  await mq.assertExchange("stockflow", "topic", { durable: true });

  const q = await mq.assertQueue("notifications", { durable: true });
  mq.bindQueue(q.queue, "stockflow", "stock.low");

  console.log("[Notifications] Esperando eventos stock.low...");
  mq.consume(q.queue, async (msg) => {
    if (!msg) return;
    try {
      const event = JSON.parse(msg.content.toString());
      await handleStockLow(event);
      mq.ack(msg);
    } catch (err) {
      console.error("[Notifications] Error procesando evento:", err.message);
      mq.nack(msg, false, false); // descartar para no bloquear
    }
  }, { noAck: false });
}

// ─── HANDLER PRINCIPAL ─────────────────────────
async function handleStockLow({ sku, stock, threshold }) {
  console.log(`[Notifications] Stock bajo → SKU:${sku} Stock:${stock}/${threshold}`);

  // 1. Obtener datos del proveedor asignado
  let supplier = null;
  try {
    const r = await fetch(`${SUPPLIERS}/api/suppliers/by-product/${sku}`);
    if (r.ok) supplier = (await r.json()).data;
  } catch { /* sin proveedor, igual notificamos */ }

  const productName = sku; // En prod: llamar a Catalog para nombre
  const message = buildMessage(sku, productName, stock, threshold, supplier);

  // 2. Notificar en app (siempre)
  inAppAlerts.unshift({ sku, stock, threshold, supplier, message, ts: new Date().toISOString() });
  if (inAppAlerts.length > 100) inAppAlerts.pop();

  // 3. WhatsApp al proveedor (si tiene número) y al admin
  const waNumbers = [];
  if (supplier?.whatsapp) waNumbers.push("whatsapp:+" + supplier.whatsapp.replace(/\D/g,""));
  if (process.env.ADMIN_WHATSAPP) waNumbers.push("whatsapp:+" + process.env.ADMIN_WHATSAPP.replace(/\D/g,""));

  for (const to of waNumbers) {
    await sendWhatsApp(to, message);
  }

  // 4. Email al admin
  if (process.env.ADMIN_EMAIL) {
    await sendEmail(process.env.ADMIN_EMAIL, `⚠️ Stock bajo: ${productName}`, message);
  }
}

// ─── WHATSAPP ──────────────────────────────────
async function sendWhatsApp(to, body) {
  if (!twilio) {
    console.log(`[WhatsApp SIMULADO] → ${to}\n${body}`);
    return;
  }
  try {
    await twilio.messages.create({ from: TWILIO_FROM, to, body });
    console.log(`[WhatsApp] Enviado a ${to}`);
  } catch (err) {
    console.error(`[WhatsApp] Error enviando a ${to}:`, err.message);
  }
}

// ─── EMAIL ─────────────────────────────────────
async function sendEmail(to, subject, text) {
  if (!sgMail) {
    console.log(`[Email SIMULADO] → ${to} | ${subject}`);
    return;
  }
  try {
    await sgMail.send({
      to, from: process.env.EMAIL_FROM || "noreply@stockflow.app",
      subject, text,
      html: `<pre style="font-family:sans-serif">${text}</pre>`
    });
    console.log(`[Email] Enviado a ${to}`);
  } catch (err) {
    console.error(`[Email] Error:`, err.message);
  }
}

// ─── MENSAJE ───────────────────────────────────
function buildMessage(sku, name, stock, threshold, supplier) {
  const lines = [
    `⚠️ ALERTA DE STOCK BAJO — StockFlow`,
    ``,
    `Producto: ${name}`,
    `SKU: ${sku}`,
    `Stock actual: ${stock} unidades`,
    `Umbral configurado: ${threshold} unidades`,
  ];
  if (stock === 0) lines[0] = `🚨 PRODUCTO SIN STOCK — StockFlow`;
  if (supplier) {
    lines.push(``);
    lines.push(`📦 Proveedor: ${supplier.name}`);
    if (supplier.contact_name) lines.push(`👤 Contacto: ${supplier.contact_name}`);
    if (supplier.phone)    lines.push(`📞 Teléfono: ${supplier.phone}`);
    if (supplier.email)    lines.push(`📧 Email: ${supplier.email}`);
  } else {
    lines.push(`\n⚠️ Sin proveedor asignado. Asigna uno en Configuración.`);
  }
  lines.push(`\n🕐 ${new Date().toLocaleString("es-CL")}`);
  return lines.join("\n");
}

// ══════════════════════════════════════════
// ENDPOINTS HTTP (para que el frontend consulte)
// ══════════════════════════════════════════

// GET /api/notifications/in-app — obtener alertas en app
app.get("/api/notifications/in-app", (req, res) => {
  res.json({ data: inAppAlerts, total: inAppAlerts.length });
});

// DELETE /api/notifications/in-app/:sku — marcar como leída
app.delete("/api/notifications/in-app/:sku", (req, res) => {
  const idx = inAppAlerts.findIndex(a => a.sku === req.params.sku);
  if (idx >= 0) inAppAlerts.splice(idx, 1);
  res.json({ message: "Alerta removida" });
});

// POST /api/notifications/test — enviar notificación de prueba
app.post("/api/notifications/test", async (req, res) => {
  const { type = "whatsapp", to } = req.body;
  const msg = "✅ StockFlow — Notificación de prueba. Tus alertas funcionan correctamente.";
  if (type === "whatsapp" && to) {
    await sendWhatsApp("whatsapp:+" + to.replace(/\D/g,""), msg);
    return res.json({ message: "WhatsApp de prueba enviado" });
  }
  if (type === "email" && to) {
    await sendEmail(to, "✅ StockFlow — Prueba de alertas", msg);
    return res.json({ message: "Email de prueba enviado" });
  }
  res.status(400).json({ error: "Tipo o destino inválido" });
});

app.get("/health", (req, res) => res.json({ status: "ok", service: "notifications" }));

initMQ()
  .then(() => app.listen(PORT, () => console.log(`[Notifications] Puerto ${PORT}`)))
  .catch(err => {
    console.warn("[Notifications] Sin RabbitMQ, solo HTTP:", err.message);
    app.listen(PORT, () => console.log(`[Notifications] Puerto ${PORT} (sin MQ)`));
  });
