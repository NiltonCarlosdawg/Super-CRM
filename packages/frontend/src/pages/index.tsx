import { Link } from "react-router-dom";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background font-sans">
      <main className="py-12 px-4 max-w-2xl mx-auto">
        <section className="hero-section">
          <h1 className="text-4xl sm:text-5xl font-serif font-medium tracking-tight">
            Gestão de WhatsApp para <br />Telecomunicações
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-xl">
            Controle múltiplas contas, campanhas automatizadas e IA qualification
            em um só lugar.
          </p>
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Link
              to="/accounts"
              className="group bg-card p-6 rounded-lg border hover:bg-muted/50 transition-colors cursor-pointer"
            >
              <svg
                className="w-6 h-6 group-hover:text-primary shrink-0"
                fill="currentColor"
                viewBox="0 0 20 20"
                aria-hidden="true"
              >
                <path d="M9 5l-4 4 1.41 1.41L11 9l4-4-1.41-1.41z" />
                <path d="M15 5l-4 4 1.41 1.41L16 9l4-4-1.41-1.41z" />
              </svg>
              <span className="ml-3">Contas WhatsApp</span>
            </Link>

            <Link
              to="/campaigns"
              className="group bg-card p-6 rounded-lg border hover:bg-muted/50 transition-colors cursor-pointer"
            >
              <svg
                className="w-6 h-6 group-hover:text-primary shrink-0"
                fill="currentColor"
                viewBox="0 0 20 20"
                aria-hidden="true"
              >
                <path d="M9 5l-4 4 1.41 1.41L11 9l4-4-1.41-1.41z" />
                <path d="M15 5l-4 4 1.41 1.41L16 9l4-4-1.41-1.41z" />
              </svg>
              <span className="ml-3">Campanhas</span>
            </Link>

            <Link
              to="/login"
              className="group bg-card p-6 rounded-lg border hover:bg-muted/50 transition-colors cursor-pointer"
            >
              <svg
                className="w-6 h-6 group-hover:text-primary shrink-0"
                fill="currentColor"
                viewBox="0 0 20 20"
                aria-hidden="true"
              >
                <path d="M9 5l-4 4 1.41 1.41L11 9l4-4-1.41-1.41z" />
                <path d="M15 5l-4 4 1.41 1.41L16 9l4-4-1.41-1.41z" />
              </svg>
              <span className="ml-3">Entrar no painel</span>
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}