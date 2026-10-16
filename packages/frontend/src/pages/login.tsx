// Página de login (Task 6): email+palavra-passe e o desvio de TOTP com QR.
// A máquina de estados é do useSession (Task 2); aqui só se apresenta.

import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { useSession, type SessionError } from "../lib/auth";
import { Button } from "../components/ui/Button";
import { Field } from "../components/ui/Field";

/** Códigos do problem+json → copy PT-AO; resto cai no detail do backend. */
const LOGIN_ERRORS: Record<string, string> = {
  invalid_credentials: "Email ou palavra-passe incorrectos",
  rate_limited: "Muitas tentativas — tenta de novo dentro de um minuto",
  network: "Sem ligação ao servidor",
};

export function errorText(error: SessionError | null): string | null {
  if (error === null) return null;
  return LOGIN_ERRORS[error.title] ?? error.detail ?? "Erro ao entrar";
}

export default function LoginPage() {
  const { status, otpauthUrl, error, login, verifyTotp, logout } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  // Sessão completa: o /login já cumpriu o papel — segue para o painel.
  if (status === "authed") return <Navigate to="/" replace />;

  const submitCredentials = (event: FormEvent) => {
    event.preventDefault();
    void login(email, password);
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) return;
    void verifyTotp(code);
  };

  const showingCode = status === "mfa_setup" || status === "mfa_required";
  const message = errorText(error);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <p className="mb-3 text-xs uppercase tracking-[0.2em] text-accent">MilVendas · CRM</p>
        <h1 className="font-display text-4xl font-light leading-tight text-fg">
          Painel MilVendas
        </h1>
        <div className="mt-8 border border-border bg-surface p-6">
          {!showingCode ? (
            <form onSubmit={submitCredentials} className="flex flex-col gap-4">
              <Field
                label="Email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <Field
                label="Palavra-passe"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <Button type="submit" variant="solid">
                Entrar
              </Button>
            </form>
          ) : (
            <form onSubmit={submitCode} className="flex flex-col gap-4">
              {otpauthUrl !== null && (
                <div className="flex flex-col items-center gap-3">
                  <QRCodeSVG value={otpauthUrl} size={176} bgColor="#ffffff" fgColor="#0a0a0c" />
                  <p className="text-center text-xs text-muted">
                    Activa o TOTP: escaneia o código com a tua app de autenticação (Google
                    Authenticator, Authy…)
                  </p>
                </div>
              )}
              <Field
                label="Código de confirmação"
                inputMode="numeric"
                maxLength={6}
                pattern="\d{6}"
                required
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <Button type="submit" variant="solid">
                Confirmar
              </Button>
              {/* Sessão pendente (setup interrompido) — logout está no MFA allowlist. */}
              <button
                type="button"
                onClick={() => void logout()}
                className="text-center text-xs text-muted underline hover:text-fg"
              >
                Usar outra conta
              </button>
            </form>
          )}
          {message !== null && (
            <p role="alert" className="mt-4 text-sm text-danger">
              {message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
