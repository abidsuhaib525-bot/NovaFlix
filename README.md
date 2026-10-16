---
title: NovaFlixZone
emoji: 🎬
colorFrom: red
colorTo: purple
sdk: docker
app_port: 7860
---

<div align="center">

# 🎬 NovaFlixZone

**A modern, cinema-grade web streaming platform with ultra-low latency playback, multi-source resolution switching, rich cast metadata, and sleek responsive UI.**

[![License](https://img.shields.io/badge/license-MIT%2FApache--2.0-amber.svg?style=flat-square)](#license)
[![React](https://img.shields.io/badge/React-19-blue.svg?style=flat-square&logo=react)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF.svg?style=flat-square&logo=vite)](https://vitejs.dev/)
[![Rust](https://img.shields.io/badge/Rust-Axum_0.8-DEA584.svg?style=flat-square&logo=rust)](https://www.rust-lang.org/)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-v4-38B2AC.svg?style=flat-square&logo=tailwind-css)](https://tailwindcss.com/)

</div>

---

## ✨ Features

- **📺 Full Web Experience:** High-performance Single Page Application (React 19 + TypeScript + Vite + Tailwind CSS v4) with dark cinema aesthetic.
- **⚡ Shaka Player Engine:** Custom Netflix-style HTML5 video player powered by Shaka Player:
  - Multi-resolution switching (`4K`, `1080p`, `720p`, `480p`, `Auto ABR`).
  - Resilient network auto-recovery with automatic retry on packet drops.
  - Multi-language audio tracks & external subtitle auto-loader (SRT, VTT, ASS).
  - Aspect ratio switcher (`Contain`, `Cover / Cinema Fill`, `16:9`, `Stretch`).
  - Sleek, non-intrusive circular buffering indicators that keep the screen clear.
- **🎥 Official YouTube Trailers:** Direct in-app trailer playback powered by TMDB Videos API.
- **👥 Top-Billed Cast & Crew:** High-resolution actor avatars, character roles, and filmography previews like Movnix.
- **🎞️ Seasons & Episodes Layout:**
  - Compact Movnix-style horizontal & grid episode cards with individual production stills, episode titles, and runtimes.
  - Quick Grid / List toggle switcher.
- **📥 In-Browser Download Manager:** Direct download options in both MP4 (Standard) and MKV (Original) with quality selection.
- **🌐 Dual-Engine Deployment:**
  - High-speed Rust backend built with **Axum** serves streaming proxy endpoints and production SPA assets directly.
  - Vite dev server with Hot Module Replacement (HMR) for development.

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js**: v18+ (Node.js 20+ recommended)
- **Rust**: 1.80+ (only required if building the native Axum backend server)

---

### 2. Running Frontend (Vite Dev Server)

```bash
cd web
npm install
npm run dev
```

The web application will be live at:
👉 **`http://localhost:5173`**

---

### 3. Running Backend (Rust Axum Server)

From the project root:

```bash
cargo run
```

The unified API server & static web app will be served on:
👉 **`http://127.0.0.1:8080`**

---

### 4. Building Production Bundle

To build the optimized frontend assets:

```bash
cd web
npm run build
```

This compiles static assets into `web/dist/`, which the Rust server serves with zero extra configuration.

---

## 🛠️ Tech Stack

| Layer | Technologies |
|---|---|
| **Frontend Framework** | React 19, TypeScript, React Router v7 |
| **Styling & Theme** | Tailwind CSS v4, Lucide Icons, Custom Cinema Design System |
| **Media Engine** | Shaka Player 4.12+ (DASH, MP4, HLS, WebVTT, SRT, ASS) |
| **Data & State** | TanStack React Query v5, Zustand |
| **Backend & Proxy** | Rust, Axum 0.8, Tower, Tokio, Reqwest |
| **Metadata Enrichment**| TMDB API v3 (Cast, High-Res Stills, Trailers, Overviews) |

---

## 📄 License

Dual-licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.
