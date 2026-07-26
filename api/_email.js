// api/_email.js — Resend email helper (not a serverless function)
// Requires env var: RESEND_API_KEY

async function sendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY no configurado en variables de entorno de Vercel');

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'StockFlow <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
      ...(text ? { text } : {}),
    }),
  });

  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.message || `Resend error ${r.status}`);
  }
  return r.json();
}

function inviteEmailHtml({ username, display_name, inviteUrl, inviterName }) {
  const name = display_name || username;
  const from = inviterName || 'el equipo';
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:40px 16px;background:#f5f6fa;font-family:'Helvetica Neue',Arial,sans-serif">
  <div style="max-width:480px;margin:0 auto">

    <!-- Header -->
    <div style="background:#5b4fff;border-radius:16px 16px 0 0;padding:32px 32px 28px;text-align:center">
      <div style="width:60px;height:60px;background:rgba(255,255,255,.15);border-radius:16px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:14px;font-size:30px">📦</div>
      <div style="color:#fff;font-size:24px;font-weight:900;letter-spacing:-.5px">StockFlow</div>
      <div style="color:rgba(255,255,255,.65);font-size:12px;margin-top:4px;font-weight:500">OMS · WMS · Sistema de gestión</div>
    </div>

    <!-- Body -->
    <div style="background:#fff;padding:32px;border-left:1px solid #e4e5f0;border-right:1px solid #e4e5f0">
      <h2 style="margin:0 0 10px;font-size:21px;color:#1a1a2e;font-weight:900">¡Hola, ${name}! 👋</h2>
      <p style="color:#5a5b7a;font-size:15px;line-height:1.65;margin:0 0 8px">
        <strong>${from}</strong> te ha invitado a unirte a <strong>StockFlow</strong>.
      </p>
      <p style="color:#5a5b7a;font-size:15px;line-height:1.65;margin:0 0 28px">
        Haz clic en el botón para crear tu contraseña y acceder al sistema de gestión de órdenes e inventario.
      </p>

      <a href="${inviteUrl}"
         style="display:block;background:#5b4fff;color:#fff;text-decoration:none;text-align:center;padding:16px 24px;border-radius:12px;font-size:16px;font-weight:800;margin-bottom:24px;letter-spacing:-.2px">
        Crear mi contraseña →
      </a>

      <div style="background:#f8f8fc;border:1px solid #e4e5f0;border-radius:10px;padding:14px 16px">
        <div style="font-size:12px;color:#9a9bb8;line-height:1.6">
          <strong style="color:#5a5b7a">Tu usuario:</strong> <code style="background:#ede9ff;color:#5b4fff;padding:1px 6px;border-radius:4px;font-size:12px">${username}</code><br>
          <strong style="color:#5a5b7a">Enlace válido por:</strong> 7 días<br><br>
          Si no esperabas esta invitación, puedes ignorar este correo sin problema.
        </div>
      </div>

      <p style="font-size:12px;color:#c4c5d8;margin:20px 0 0;line-height:1.5">
        O copia este enlace en tu navegador:<br>
        <span style="word-break:break-all;color:#9a9bb8">${inviteUrl}</span>
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#f0f1f7;border:1px solid #e4e5f0;border-top:none;border-radius:0 0 16px 16px;padding:16px 32px;text-align:center">
      <div style="font-size:11px;color:#9a9bb8">StockFlow OMS · Bichon Labs © ${new Date().getFullYear()}</div>
    </div>

  </div>
</body>
</html>`;
}

module.exports = { sendEmail, inviteEmailHtml };
