import { defineConfig } from "vite";

export default defineConfig({
  // Root past do project (onde o package.json fica)
  root: ".",

  // Directório público onde o index.html fica
  publicDir: "public",

  // Server
  server: {
    port: 3000,
    open: true,
    host: "localhost",
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