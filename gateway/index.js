// gateway/index.js — API Gateway
// Punto de entrada único. Valida JWT y enruta a cada microservicio.

const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const jwt = require("jsonwebtoken");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

// ─── CORS ──────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── HEALTH CHECK ──────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", service: "gateway" }));

// ─── AUTH MIDDLEWARE ───────────────────────────
// Rutas públicas que no necesitan JWT
const PUBLIC_ROUTES = [
  { path: "/api/auth/login",       method: "POST" },
  { path: "/api/auth/register",    method: "POST" },
  { path: "/api/webhooks/shopify", method: "POST" },
  { path: "/track/",              method: "GET"  }, // Tracking público sin auth
];

function authMiddleware(req, res, next) {
  const isPublic = PUBLIC_ROUTES.some(
    (r) => req.path.startsWith(r.path) && req.method === r.method
  );
  if (isPublic) return next();

  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Token requerido" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Token inválido o expirado" });
  }
}

app.use(authMiddleware);

// ─── PROXY ROUTES ──────────────────────────────
const services = [
  { prefix: "/api/catalog",       target: process.env.CATALOG_URL   || "http://localhost:3001" },
  { prefix: "/api/inventory",     target: process.env.WMS_URL        || "http://localhost:3002" },
  { prefix: "/api/kits",          target: process.env.WMS_URL        || "http://localhost:3002" },
  { prefix: "/api/movements",     target: process.env.WMS_URL        || "http://localhost:3002" },
  { prefix: "/api/orders",        target: process.env.OMS_URL        || "http://localhost:3003" },
  { prefix: "/api/webhooks",      target: process.env.OMS_URL        || "http://localhost:3003" },
  { prefix: "/api/purchases",     target: process.env.PURCHASES_URL  || "http://localhost:3004" },
  { prefix: "/api/suppliers",     target: process.env.SUPPLIERS_URL  || "http://localhost:3005" },
  { prefix: "/api/auth",          target: process.env.USERS_URL      || "http://localhost:3006" },
  { prefix: "/api/users",         target: process.env.USERS_URL      || "http://localhost:3006" },
  { prefix: "/api/profiles",      target: process.env.USERS_URL      || "http://localhost:3006" },
  { prefix: "/api/locales",       target: process.env.LOCALES_URL    || "http://localhost:3009" },
  { prefix: "/api/delivery",      target: process.env.DELIVERY_URL    || "http://localhost:3008" },
  { prefix: "/track",             target: process.env.DELIVERY_URL    || "http://localhost:3008" },
  { prefix: "/api/notifications", target: "http://localhost:3007" },
];

services.forEach(({ prefix, target }) => {
  app.use(
    prefix,
    createProxyMiddleware({
      target,
      changeOrigin: true,
      on: {
        error: (err, req, res) => {
          console.error(`[Gateway] Error → ${prefix}:`, err.message);
          res.status(502).json({ error: "Servicio no disponible", service: prefix });
        },
      },
    })
  );
});

// ─── 404 ───────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: "Ruta no encontrada" }));

app.listen(PORT, () => console.log(`[Gateway] Escuchando en puerto ${PORT}`));
