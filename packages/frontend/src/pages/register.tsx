// Página de registo público (Onda 1, Task 9): cria empresa + admin e segue
// directamente para o setup TOTP — o backend devolve a MESMA resposta do
// login (mfa:'setup' + cookies), por isso a máquina de estados é a mesma e
// este ecrã repete o desenho do login (Field/Button + QR).

import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { useSession } from "../lib/auth";
import { PASSWORD_HINT, registerErrorText } from "../lib/labels";
import { Button } from "../components/ui/Button";
import { Field } from "../components/ui/Field";
import { Spinner } from "../components/ui/Spinner";

export default function RegisterPage() {
  const { status, otpauthUrl, error, register, verifyTotp } = useSession();
  const [tenantName, setTenantName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  // Registo completo (só acontece com MFA resolvido) — segue para o painel.
  if (status === "authed") return <Navigate to="/" replace />;

  // Boot ainda a decidir: sem flash do form (o /me pode já ter sessão).
  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="A verificar sessão" />
      </div>
    );
  }

  const submitForm = (event: FormEvent) => {
    event.preventDefault();
    void register({ tenantName, name, email, password });
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) return;
    void verifyTotp(code);
  };

  // Após o register o estado é mfa_setup; também cobre mfa_required se o
  // /me do boot encontrar sessão pendente de TOTP.
  const showingCode = status === "mfa_setup" || status === "mfa_required";
  const message = registerErrorText(error);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <p className="mb-3 text-xs uppercase tracking-[0.2em] text-accent">MilVendas · CRM</p>
        <h1 className="font-display text-4xl font-light leading-tight text-fg">
          Cria a tua empresa
        </h1>
        <div className="mt-8 border border-border bg-surface p-6">
          {!showingCode ? (
            <form onSubmit={submitForm} className="flex flex-col gap-4">
              <Field
                label="Nome da empresa"
                required
                autoComplete="organization"
                value={tenantName}
                onChange={(event) => setTenantName(event.target.value)}
              />
              <Field
                label="O teu nome"
                required
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
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
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <p className="text-xs text-muted">{PASSWORD_HINT}</p>
              <Button type="submit" variant="solid">
                Criar conta
              </Button>
            </form>
          ) : (
            <form onSubmit={submitCode} className="flex flex-col gap-4">
              <p className="text-sm text-accent">
                O registo está quase completo — falta activar o TOTP na tua conta de administrador.
              </p>
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
            </form>
          )}
          {message !== null && (
            <p role="alert" className="mt-4 text-sm text-danger">
              {message}
            </p>
          )}
        </div>
        <p className="mt-4 text-center text-sm text-muted">
          <Link to="/login" className="underline hover:text-fg">
            Já tens conta? Entra
          </Link>
        </p>
      </div>
    </main>
  );
}
