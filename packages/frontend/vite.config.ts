import { defineConfig } from "vite";

export default defineConfig({
  // Root past do project (onde o package.json fica)
  root: ".",

  // Directório público onde o index.html fica
  publicDir: "public",

  // Server
  server: {
    port: 3000,
    open: false,
    host: "localhost",
    // Same-origin com o backend: cookies de sessão e CSRF sem CORS.
    proxy: {
      "/v1": "http://localhost:3001",
      "/socket.io": { target: "http://localhost:3001", ws: true },
    },
  },

  // Build
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },

  // Resolve aliases
  resolve: {
    alias: {
      "@": "./src",
    },
  },

  // Env
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
});