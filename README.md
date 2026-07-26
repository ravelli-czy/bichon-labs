# StockFlow — OMS + WMS + Delivery

Sistema de gestión para emprendimientos y comercios.  
Stack: **Node.js 20 · MySQL 8 · RabbitMQ · Redis**

## Microservicios

| Servicio      | Puerto | Base de datos |
|---------------|--------|---------------|
| API Gateway   | 3000   | —             |
| Catalog       | 3001   | catalog_db    |
| WMS           | 3002   | wms_db        |
| OMS           | 3003   | oms_db        |
| Purchases     | 3004   | purchases_db  |
| Suppliers     | 3005   | suppliers_db  |
| Users         | 3006   | users_db      |
| Notifications | 3007   | —             |
| Delivery      | 3008   | delivery_db   |
| Locales       | 3009   | locales_db    |

## Levantar en local

### Requisitos
- Docker Desktop instalado y corriendo
- Puerto 3000–3009 y 3306 disponibles

### Pasos

```bash
# 1. Descomprimir
unzip stockflow.zip && cd stockflow

# 2. Variables de entorno
cp .env.example .env
# Editar .env si quieres cambiar algo (no es necesario para desarrollo)

# 3. Levantar todo
docker-compose up

# Primera vez tarda ~2 min mientras descarga las imágenes
# Luego: http://localhost:3000/health
```

### Verificar que todo está corriendo
```bash
curl http://localhost:3000/health
curl http://localhost:3001/health
curl http://localhost:3006/health
```

## Base de datos

MySQL 8.0. El archivo `shared/init.sql` crea automáticamente las 8 bases de datos al primer arranque. Cada microservicio crea sus propias tablas con `initDB()` al iniciar.

Conexión directa (para explorar):
```
Host:     localhost:3306
User:     stockflow
Password: stockflow123
```

## Frontend (sin backend)

Los archivos HTML en `/frontend` funcionan de forma independiente con datos en memoria. Ábrelos en el navegador o súbelos a Vercel/Netlify para empezar a operar sin backend.

## Documentación API

Ver `docs/API_REFERENCE.md`
