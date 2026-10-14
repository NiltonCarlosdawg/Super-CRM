import { useState } from "react";

export function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  async function handleSubmit() {
    setError(null);
    setRegistering(true);

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, senha }),
        credentials: "include"
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.message || "Registration failed");
        setRegistering(false);
        return;
      }

      console.log("Register success:", data.user);
      // Em produção: window.location.href = '/dashboard';
    } catch (err) {
      setError("Erro de conexão com o servidor");
      setRegistering(false);
    }
  }

  return (
    <div className="min-h-screen bg-background font-sans p-4 sm:p-8">
      <container className="max-w-md w-full space-y-6 py-12">
        <h2 className="text-3xl font-serif font-medium text-center">
          Cadastro na Verano Labs
        </h2>

        {error && (
          <div className="bg-red-100 border-l-4 red-500 rounded-b p-4 mb-4" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            name="name"
            placeholder="Nome completo"
            value={name}
            onChange={e => setName(e.target.value)}
            required
            className="input input-bordered w-full"
            aria-label="Nome completo"
          />
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
            disabled={registering}
            className="btn btn-primary w-full"
            aria-label="Criar conta"
          >
            {registering ? "Criando..." : "Criar conta"}
          </button>
        </form>

        <div className="text-sm text-muted-foreground text-center">
          {"Já tem conta?"}
          <a href="/auth/login" className="font-medium underline">
            Login
          </a>
        </div>
      </container>
    </div>
  );
}