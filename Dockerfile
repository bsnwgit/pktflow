# ── Stage 1: Build frontend ───────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend

# Install dependencies first (better layer caching)
COPY frontend/package*.json ./
RUN npm install

# Build
COPY frontend/ ./
RUN npm run build > /dev/null 2>&1 && echo "frontend build ok" || (echo "FRONTEND BUILD FAILED" && exit 1)


# ── Stage 2: Python application ───────────────────────────────────────────────
FROM python:3.9-slim

WORKDIR /app

# System dependencies
# libxmlsec1-dev + libxml2-dev: required by python3-saml
# pkg-config + gcc: required to compile xmlsec Python bindings
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxmlsec1-dev \
    libxmlsec1-openssl \
    libxml2-dev \
    pkg-config \
    gcc \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application source
COPY app/ ./app/
COPY migrations/ ./migrations/
COPY clickhouse/ ./clickhouse/
COPY config.example.yaml ./
COPY start.sh ./
RUN chmod +x start.sh

# Copy built frontend from Stage 1
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Entrypoint script (seeds admin user, then starts app)
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Persistent data lives in /data (mount a named volume here)
# /data/pktflow.db   — SQLite app database
# /data/flows.duckdb — DuckDB flow store (if DuckDB backend is selected)
# /data/logs/        — application logs
# /data/ssl/         — TLS cert + key (if HTTPS is enabled)
RUN mkdir -p /data/logs /data/ssl

EXPOSE 80 443

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["python", "-m", "app.main"]
