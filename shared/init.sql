-- StockFlow — Inicialización de bases de datos MySQL
-- Cada microservicio tiene su propia base de datos

CREATE DATABASE IF NOT EXISTS catalog_db   CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS wms_db       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS oms_db       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS purchases_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS suppliers_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS users_db     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS locales_db   CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS delivery_db  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Dar permisos al usuario stockflow sobre todas las bases
GRANT ALL PRIVILEGES ON catalog_db.*   TO 'stockflow'@'%';
GRANT ALL PRIVILEGES ON wms_db.*       TO 'stockflow'@'%';
GRANT ALL PRIVILEGES ON oms_db.*       TO 'stockflow'@'%';
GRANT ALL PRIVILEGES ON purchases_db.* TO 'stockflow'@'%';
GRANT ALL PRIVILEGES ON suppliers_db.* TO 'stockflow'@'%';
GRANT ALL PRIVILEGES ON users_db.*     TO 'stockflow'@'%';
GRANT ALL PRIVILEGES ON locales_db.*   TO 'stockflow'@'%';
GRANT ALL PRIVILEGES ON delivery_db.*  TO 'stockflow'@'%';
FLUSH PRIVILEGES;
