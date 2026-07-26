# StockFlow — Referencia completa de APIs

Base URL en producción: `https://tu-dominio.com`
Todos los endpoints requieren `Authorization: Bearer <token>` salvo los indicados.

---

## 🔐 Auth (Users — puerto 3006)

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| POST | `/api/auth/register` | Crear usuario *(público)* |
| POST | `/api/auth/login` | Iniciar sesión → retorna JWT *(público)* |
| POST | `/api/auth/refresh` | Renovar token |
| POST | `/api/auth/logout` | Cerrar sesión |

### POST /api/auth/login
```json
// Body
{ "email": "admin@tienda.cl", "password": "secreto123" }

// Response 200
{ "data": { "id": "uuid", "email": "...", "name": "...", "role": "admin" }, "token": "eyJ..." }
```

---

## 👤 Usuarios (Users — puerto 3006)

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/users` | Listar usuarios |
| GET | `/api/users/:id` | Obtener usuario |
| PUT | `/api/users/:id` | Actualizar usuario (name, role, active) |
| PUT | `/api/users/:id/password` | Cambiar contraseña |
| DELETE | `/api/users/:id` | Desactivar usuario |

## 📋 Perfiles (Users — puerto 3006)

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/profiles/:user_id` | Obtener perfil |
| PUT | `/api/profiles/:user_id` | Actualizar perfil y preferencias de notificación |

### PUT /api/profiles/:user_id
```json
{
  "phone": "+56 9 1234 5678",
  "whatsapp": "+56912345678",
  "notify_email": true,
  "notify_whatsapp": true,
  "notify_app": true,
  "preferences": { "theme": "dark", "currency": "CLP" }
}
```

---

## 📦 Catálogo (Catalog — puerto 3001)

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/catalog/products` | Listar productos (?q=texto &category= &brand=) |
| GET | `/api/catalog/products/:sku` | Obtener producto |
| GET | `/api/catalog/products/barcode/:code` | Buscar por código de barras (PIM lookup) |
| POST | `/api/catalog/products` | Crear producto |
| PUT | `/api/catalog/products/:sku` | Actualizar producto |
| DELETE | `/api/catalog/products/:sku` | Desactivar producto |
| GET | `/api/catalog/categories` | Listar categorías |
| POST | `/api/catalog/categories` | Crear categoría |
| DELETE | `/api/catalog/categories/:id` | Eliminar categoría |
| GET | `/api/catalog/product-groups` | Listar grupos de productos |
| POST | `/api/catalog/product-groups` | Crear grupo de productos (id correlativo automático) |
| PUT | `/api/catalog/product-groups/:id` | Renombrar grupo de productos |
| DELETE | `/api/catalog/product-groups/:id` | Eliminar grupo de productos |
| GET | `/api/catalog/products/:sku/groups` | Grupos asignados a un producto |
| PUT | `/api/catalog/products/:sku/groups` | Reemplazar los grupos de un producto (0..N) |

### POST /api/catalog/products
```json
{
  "sku": "PRD-001",
  "barcode": "7501234567890",
  "name": "Cámara IP 1080p",
  "brand": "Hikvision",
  "category": "Seguridad",
  "unit": "unidad",
  "cost_price": 45000,
  "sale_price": 79000,
  "supplier_id": "SUP-001",
  "group_ids": [1, 3]
}
```

### Grupo de Productos

Permite agrupar productos de forma transversal a las categorías (base para futuras
funcionalidades: manejo de pesables, productos de alto valor, etc). Un producto puede
pertenecer a cero, uno o varios grupos.

```json
// POST /api/catalog/product-groups
{ "name": "Pesables" }

// Response 201
{ "data": { "id": 1, "name": "Pesables", "created_at": "2026-07-26T00:00:00.000Z" } }

// PUT /api/catalog/products/PRD-001/groups
{ "group_ids": [1, 3] }

// Response 200
{ "data": [ { "id": 1, "name": "Pesables" }, { "id": 3, "name": "Alto valor" } ] }
```

Cada producto devuelto por `GET /api/catalog/products` y `GET /api/catalog/products/:sku`
incluye el arreglo `groups` con los grupos a los que pertenece.

---

## 🏭 Inventario / WMS (WMS — puerto 3002)

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/inventory` | Listar inventario (?low_stock=true) |
| GET | `/api/inventory/:sku` | Stock de un SKU |
| POST | `/api/inventory` | Crear registro de inventario para un SKU |
| PUT | `/api/inventory/:sku/threshold` | Actualizar umbral de alerta |
| POST | `/api/inventory/:sku/stock` | Ajustar stock (in / out / adjust) |
| DELETE | `/api/inventory/:sku` | Eliminar registro (solo si stock=0) |
| GET | `/api/inventory/alerts` | Alertas activas de stock bajo |
| GET | `/api/movements` | Historial de movimientos (?sku= &type= &from= &to=) |
| GET | `/api/movements/:sku` | Historial de un SKU |

### POST /api/inventory/:sku/stock — ajustar stock
```json
// Ingresar 10 unidades
{ "type": "in", "qty": 10, "reference": "OC-001", "note": "Compra mayo" }

// Retirar 3 unidades
{ "type": "out", "qty": 3, "reference": "ORD-001", "note": "Venta" }

// Ajuste directo a 25 unidades
{ "type": "adjust", "qty": 25, "note": "Inventario físico" }
```

---

## 📦 KITs (WMS — puerto 3002)

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/kits` | Listar KITs con stock calculado |
| GET | `/api/kits/:sku` | Detalle de un KIT |
| POST | `/api/kits` | Crear KIT |
| PUT | `/api/kits/:sku` | Actualizar KIT (nombre, componentes, activo) |
| DELETE | `/api/kits/:sku` | Desactivar KIT |
| POST | `/api/kits/:sku/consume` | Consumir stock del KIT (llamado por OMS) |

### POST /api/kits — crear KIT
```json
{
  "sku": "KIT-001",
  "name": "Kit Seguridad Básico",
  "components": [
    { "product_sku": "PRD-001", "qty": 1 },
    { "product_sku": "PRD-002", "qty": 2 },
    { "product_sku": "PRD-003", "qty": 1 }
  ]
}
```

### GET /api/kits — respuesta con stock calculado
```json
{
  "data": [{
    "sku": "KIT-001",
    "name": "Kit Seguridad Básico",
    "available_stock": 4,
    "components": [
      { "product_sku": "PRD-001", "qty": 1 },
      { "product_sku": "PRD-002", "qty": 2 }
    ]
  }]
}
```

---

## 🛒 Órdenes de Venta / OMS (OMS — puerto 3003)

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/orders` | Listar órdenes (?channel= &from= &to= &status=) |
| GET | `/api/orders/summary` | Totales para dashboard |
| GET | `/api/orders/:id` | Detalle de una orden |
| POST | `/api/orders` | Crear orden manual |
| PUT | `/api/orders/:id` | Actualizar estado / nota |
| DELETE | `/api/orders/:id` | Cancelar orden (devuelve stock) |

### POST /api/orders — crear orden
```json
{
  "customer_name": "Juan Pérez",
  "customer_email": "juan@email.cl",
  "channel": "manual",
  "items": [
    { "item_type": "kit",     "sku": "KIT-001", "qty": 2, "unit_price": 139000 },
    { "item_type": "product", "sku": "PRD-005", "qty": 5, "unit_price": 1200 }
  ],
  "note": "Pago en efectivo"
}
```

### POST /api/webhooks/shopify *(público — verificado con HMAC)*
Shopify envía las órdenes aquí automáticamente.
Configurar en: Shopify Admin → Settings → Notifications → Webhooks
- Evento: `orders/create`
- URL: `https://tu-dominio.com/api/webhooks/shopify`
- Formato: JSON

---

## 🚚 Órdenes de Compra (Purchases — puerto 3004)

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/purchases` | Listar ÓC (?supplier_id= &status= &from= &to=) |
| GET | `/api/purchases/summary` | Totales de gasto |
| GET | `/api/purchases/:id` | Detalle de una ÓC |
| POST | `/api/purchases` | Crear ÓC |
| PUT | `/api/purchases/:id` | Actualizar datos (doc, notas) |
| POST | `/api/purchases/:id/receive` | Marcar como recibida (actualiza stock) |
| DELETE | `/api/purchases/:id` | Cancelar ÓC (solo pending) |

### POST /api/purchases — crear ÓC
```json
{
  "supplier_id": "SUP-001",
  "supplier_name": "Hikvision Chile",
  "doc_number": "FAC-00892",
  "doc_type": "factura",
  "status": "pending",
  "items": [
    { "product_sku": "PRD-001", "qty": 10, "unit_cost": 45000 }
  ],
  "notes": "Pago a 30 días"
}
```

---

## 🏪 Proveedores (Suppliers — puerto 3005)

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/suppliers` | Listar proveedores (?q=búsqueda) |
| GET | `/api/suppliers/:id` | Detalle + productos del proveedor |
| GET | `/api/suppliers/by-product/:sku` | Proveedor asignado a un SKU (para alertas) |
| POST | `/api/suppliers` | Crear proveedor |
| PUT | `/api/suppliers/:id` | Actualizar proveedor |
| PUT | `/api/suppliers/:id/products` | Actualizar lista de productos del proveedor |
| DELETE | `/api/suppliers/:id` | Desactivar proveedor |

### POST /api/suppliers — crear proveedor
```json
{
  "name": "Hikvision Chile S.A.",
  "rut": "76.123.456-7",
  "phone": "+56 2 2345 6789",
  "whatsapp": "+56223456789",
  "email": "ventas@hikvision.cl",
  "contact_name": "Carlos Vega",
  "address": "Av. Providencia 1234, Santiago",
  "notes": "Pago a 30 días. Entrega en 3-5 días hábiles."
}
```

---

## 🔔 Notificaciones (Notifications — puerto 3007)

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/notifications/in-app` | Alertas pendientes en app |
| DELETE | `/api/notifications/in-app/:sku` | Marcar alerta como leída |
| POST | `/api/notifications/test` | Enviar notificación de prueba |

### Flujo automático de alertas
```
stock.stock <= stock.threshold
  → RabbitMQ: stock.low { sku, stock, threshold }
    → Notifications escucha el evento
      → GET /api/suppliers/by-product/:sku → obtiene proveedor
        → WhatsApp al proveedor + al admin
        → Email al admin
        → In-app alert
```

---

## 📊 Financiero (combinado en frontend)

Para el dashboard financiero, el frontend hace estas dos llamadas:

```
GET /api/purchases/summary?from=2025-01-01
→ { total_spent: 755000, total_orders: 3, pending_count: 1 }

GET /api/orders/summary?from=2025-01-01
→ { total_revenue: 556000, total_orders: 2, shopify_revenue: 139000 }

Utilidad = total_revenue - total_spent = -199000
Margen   = utilidad / total_revenue * 100
```

---

## 🔑 Roles y permisos

| Rol | Descripción |
|-----|-------------|
| `admin` | Acceso total, gestión de usuarios |
| `manager` | Todo excepto gestión de usuarios |
| `operator` | Solo lectura y ajuste de stock |

El Gateway puede validar roles antes de enrutar usando el payload del JWT.

---

## 🚚 Delivery (puerto 3008)

### Máquina de estados

```
ready → on_the_way → delivered   (estado final)
                   → not_delivered → ready  (reagendamiento)
```

| Estado | Label |
|--------|-------|
| `ready` | Listo para enviar |
| `on_the_way` | En camino |
| `delivered` | Entregado |
| `not_delivered` | No entregado |

---

### Couriers

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/delivery/couriers` | Listar couriers con sus zonas |
| GET | `/api/delivery/couriers/:id` | Detalle + stats del courier |
| GET | `/api/delivery/couriers/for-zone/:zone` | Couriers que cubren una zona |
| POST | `/api/delivery/couriers` | Crear courier con zonas |
| PUT | `/api/delivery/couriers/:id` | Actualizar courier |
| PUT | `/api/delivery/couriers/:id/zones` | Reemplazar zonas de cobertura |
| DELETE | `/api/delivery/couriers/:id` | Desactivar courier |

### POST /api/delivery/couriers
```json
{
  "name": "StarShipping Chile",
  "rut": "77.123.456-8",
  "phone": "+56 2 2222 3333",
  "email": "ops@starshipping.cl",
  "contact_name": "Pedro Rojas",
  "zones": [
    { "zone_name": "Santiago Centro", "zone_code": "SCL-01", "delivery_days": 1, "base_cost": 2500 },
    { "zone_name": "Providencia",     "zone_code": "SCL-02", "delivery_days": 1, "base_cost": 2500 },
    { "zone_name": "Maipú",           "zone_code": "SCL-10", "delivery_days": 2, "base_cost": 3500 }
  ]
}
```

---

### Shipments (Envíos)

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/delivery/shipments` | Listar envíos (?status= &courier_id= &date= &from= &to=) |
| GET | `/api/delivery/shipments/summary` | Métricas: total, por estado, tasa de entrega, costo |
| GET | `/api/delivery/shipments/:id` | Detalle + historial de estados |
| GET | `/api/delivery/shipments/:id/history` | Historial de estados completo |
| POST | `/api/delivery/shipments` | Crear envío |
| PUT | `/api/delivery/shipments/:id` | Actualizar datos del envío |
| POST | `/api/delivery/shipments/:id/status` | Cambiar estado (respeta la máquina) |
| POST | `/api/delivery/shipments/:id/reschedule` | Reagendar (Not Delivered → Ready) |
| DELETE | `/api/delivery/shipments/:id` | Cancelar (solo si está en Ready) |

### POST /api/delivery/shipments
```json
{
  "order_id": "ORD-001",
  "courier_id": "COU-ABC123",
  "recipient_name": "Juan Pérez",
  "recipient_phone": "+56 9 8765 4321",
  "recipient_email": "juan@email.cl",
  "address_street": "Av. Providencia 1234, Depto 3B",
  "address_city": "Providencia",
  "address_region": "Región Metropolitana",
  "address_zip": "7500000",
  "address_notes": "Timbre roto, llamar al llegar",
  "zone_name": "Providencia",
  "scheduled_date": "2025-06-15",
  "delivery_window_from": "10:00",
  "delivery_window_to": "14:00",
  "shipping_cost": 2500,
  "notes": "Frágil"
}
```

### POST /api/delivery/shipments/:id/status
```json
{ "status": "on_the_way", "note": "Salió en ruta a las 09:30", "changed_by": "repartidor@courier.cl" }
{ "status": "delivered",  "note": "Recibió el portero" }
{ "status": "not_delivered", "note": "Nadie en casa, se dejó aviso" }
```

Si el estado no es válido según la máquina de estados, retorna `409` con las transiciones permitidas.

### POST /api/delivery/shipments/:id/reschedule
```json
{
  "scheduled_date": "2025-06-17",
  "delivery_window_from": "14:00",
  "delivery_window_to": "18:00",
  "courier_id": "COU-XYZ789",
  "note": "Cliente solicitó reagendar por viaje"
}
```

---

### Etiquetas de envío

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/delivery/shipments/:id/label` | Generar etiqueta HTML imprimible |
| PUT | `/api/delivery/shipments/:id/label-config` | Guardar config de etiqueta |

### GET /api/delivery/shipments/:id/label — parámetros
| Param | Opciones | Default |
|-------|----------|---------|
| `size` | `10x15`, `A4`, `A5`, `4x6` | `10x15` |
| `show_qr` | `true/false` | `true` |
| `show_logo` | `true/false` | `true` |
| `font_size` | `small`, `medium`, `large` | `medium` |
| `fields` | `recipient,address,scheduled_date,window,courier,tracking,order_id,notes` | todos |

Ejemplo: `/api/delivery/shipments/SHP-001/label?size=A5&show_qr=true&fields=recipient,address,scheduled_date,tracking`

Retorna HTML listo para imprimir con botón "Imprimir" integrado.

---

### Tracking público (sin autenticación)

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/track/:code` | Estado del envío para el cliente |

```
URL pública: https://tu-dominio.com/track/SFABC12345

Retorna:
- Estado actual con label legible
- Historial de estados con fechas
- Datos de entrega (fecha, ventana horaria)
- Nombre del courier
- QR code como data URL (para incrustar en email)
```

---

### Flujo completo de un envío

```
1. OMS crea orden → emite order.created con datos de shipping
   → Delivery escucha y crea shipment automáticamente (status: ready)

2. Operador asigna courier y confirma
   → PUT /api/delivery/shipments/:id  { courier_id }

3. Sale a ruta
   → POST /api/delivery/shipments/:id/status  { status: "on_the_way" }
   → attempts++ automáticamente

4a. Entrega exitosa
    → POST /status { status: "delivered" }
    → delivered_at = NOW()

4b. No se pudo entregar
    → POST /status { status: "not_delivered", note: "Nadie en casa" }

5. Reagendar (si no entregado)
   → POST /reschedule { scheduled_date, window, courier_id }
   → Vuelve a status: ready → continuar desde paso 3
```

### Métricas disponibles (GET /api/delivery/shipments/summary)
```json
{
  "total": 45,
  "ready": 8,
  "on_the_way": 12,
  "delivered": 21,
  "not_delivered": 4,
  "total_shipping_cost": 112500,
  "delivery_rate": 84.0
}
```
