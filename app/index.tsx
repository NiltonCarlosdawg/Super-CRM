import Header from "@/components/Header";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background font-sans">
      <Header />
      <main className="py-12 px-4 max-w-2xl mx-auto">
        <section className="hero-section">
          <h1 className="text-4xl sm:text-5xl font-serif font-medium tracking-tight">
            Gestão de WhatsApp para <br />Telecomunicações
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-xl">
            Controle múltiplas contas, campanhas automatizadas e IA qualification em um só lugar.
          </p>
          <CTAButton />
        </section>
      </main>
    </div>
  );
}

function CTAButton() {
  return (
    <a href="/auth/login" className="mt-8 inline-block px-6 py-3 bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-opacity">
      Começar grátis
    </a>
  );
}