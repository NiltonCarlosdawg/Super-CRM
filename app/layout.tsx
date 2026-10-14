import "./globals.css";
import type { React } from "react";
import { useState, type KeyboardEvent } from "react";

// Persist theme choice in localStorage
const storedTheme = localStorage.getItem("theme") as "light" | "dark" | null;
const [theme, setTheme] = useState<"light" | "dark">(
  storedTheme || (typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
);

// Apply theme to root
const setThemeOnRoot = (t: "light" | "dark") => {
  setTheme(t);
  localStorage.setItem("theme", t);
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(t);
};

// If theme changes via system, update
if (typeof window !== "undefined") {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    const stored = localStorage.getItem("theme");
    if (!stored) setTheme(e.matches ? "dark" : "light");
  });
};

export const metadata: Metadata = {
  title: "Verano Labs CRM",
  description: "Sistema completo de gestão de projetos multi-tenant",
};

export default function RootLayout({
  children,
}: { children: React.ReturnType }) {
  return (
    <html
      className={`font-sant [&_*:focus-visible]:outline-[2px] [&_*:focus-visible]:ring-ring [&_*:focus-visible]:ring-offset-background [class*="bg-"]:antialiased [class*="text-"]:antialiased`}
      onLoad={setThemeOnRoot(theme)}
    >
      <body className={`light ${theme === "light" ? "light" : ""} dark ${theme === "dark" ? "dark" : ""} min-h-screen bg-background font-sans antialiased`}
        role="dialog"
      >
        <header className="border-b bg-background/80 backdrop-blur-md">
          <div className="max-w-7xl mx-auto px-4 flex items-center justify-between h-16">
            <h1 className="font-serif font-medium text-lg">
              <span className="hidden sm:inline">Verano Labs CRM</span>
              <span className="block sm:hidden">Verano Labs</span>
            </h1>
            <div className="flex items-center gap-3">
              {/* Login/Cadastro links para small screens */}
              <div className="hidden sm:flex items-center gap-2">
                <a
                  href="/auth/login"
                  className="btn btn-outline text-sm"
                  aria-label="Login"
                >
                  Login
                </a>
                <a
                  href="/auth/register"
                  className="btn btn-primary text-sm"
                  aria-label="Cadastro"
                >
                  Cadastro
                </a>
              </div>
            </div>
          </div>
        </header>

        <main className="py-8 px-4 max-w-2xl mx-auto">
          {children}
        </main>
      </body>
    </html>
  );
}