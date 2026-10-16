import type { Config } from "tailwindcss";

/**
 * Tokens do desenho (docs/plans/2026-10-16-frontend-completo.md §3): valores
 * medidos na referência veranolabs.pages.dev. Raio 0 em todo o lado; sem
 * sombras — a separação é sempre por borda de 1px.
 */
const config: Config = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#0a0a0c",
        surface: "#121215",
        border: "#26262b",
        fg: "#f2f2f3",
        muted: "#c6c6c6",
        accent: {
          DEFAULT: "#3b6ef6",
          hover: "#2f5ce0",
          soft: "rgba(59,110,246,0.10)",
        },
        success: "#3fb950",
        warning: "#d29922",
        danger: "#f85149",
        // Aliases lidos pelos componentes legados até serem substituídos
        // pelas páginas novas (T7/T8/T11/T12/T13) — mesmos valores escuros.
        card: "#121215",
        foreground: "#f2f2f3",
        primary: {
          DEFAULT: "#3b6ef6",
          foreground: "#ffffff",
        },
        "muted-foreground": "#c6c6c6",
      },
      fontFamily: {
        sans: ["Outfit", "system-ui", "sans-serif"],
        display: ["IBM Plex Sans", "Outfit", "sans-serif"],
      },
      borderRadius: {
        DEFAULT: "0",
        none: "0",
        sm: "0",
        md: "0",
        lg: "0",
        xl: "0",
        "2xl": "0",
        "3xl": "0",
        full: "9999px",
      },
    },
  },
  plugins: [],
};

export default config;
