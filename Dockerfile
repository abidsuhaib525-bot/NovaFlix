# Multi-stage Dockerfile for NovaFlix
# 1. Build the React frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# 2. Build the Rust backend
FROM rust:1.83-alpine AS backend-builder
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src/ ./src/
RUN cargo build --release

# 3. Final minimal runner image
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
WORKDIR /app

# Copy built backend binary and web dist assets
COPY --from=backend-builder /app/target/release/novaflix /app/novaflix
COPY --from=frontend-builder /app/web/dist /app/web/dist

ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

CMD ["/app/novaflix", "--web-root", "/app/web/dist"]
