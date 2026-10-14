import { useState } from "react";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  async function handleSubmit() {
    setError(null);
    setLoggingIn(true);

    try {
      // Chamada direta ao backend via fetch (sem cookies complexos)
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, senha }),
        credentials: "include" // isso tenta enviar cookies se existirem
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.message || "Login failed");
        setLoggingIn(false);
        return;
      }

      // Armazenar token e redirecionar
      // Em produção, o backend define o cookie via Set-Cookie
      // Aqui apenas simulamos o redirect
      console.log("Login success:", data.user);
      // Em produção: window.location.href = '/dashboard';
    } catch (err) {
      setError("Erro de conexão com o servidor");
      setLoggingIn(false);
    }
  }

  return (
    <div className="min-h-screen bg-background font-sans p-4 sm:p-8">
      <container className="max-w-md w-full space-y-6 py-12">
        <h2 className="text-3xl font-serif font-medium text-center">
          Login na Verano Labs
        </h2>

        {error && (
          <div className="bg-red-100 border-l-4 red-500 rounded-b p-4 mb-4" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email"
            name="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="input input-bordered w-full"
            aria-label="Email"
          />
          <input
            type="password"
            name="senha"
            placeholder="Senha"
            value={senha}
            onChange={e => setSenha(e.target.value)}
            required
            className="input input-bordered w-full"
            aria-label="Senha"
          />
          <button
            type="submit"
            disabled={loggingIn}
            className="btn btn-primary w-full"
            aria-label="Entrar na conta"
          >
            {loggingIn ? "Entrando..." : "Entrar"}
          </button>
        </form>

        <div className="text-sm text-muted-foreground text-center">
          {"Não tem conta?"}
          <a href="/auth/register" className="font-medium underline">
            Cadastre-se
          </a>
        </div>
      </container>
    </div>
  );
}