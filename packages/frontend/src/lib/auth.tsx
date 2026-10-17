// Sessão do utilizador (Task 2): contexto React com a máquina de estados do
// login + TOTP. Contrato do backend (adapters/http/routes/auth.ts): /me dá o
// utilizador, 401 = sem sessão, 403 mfa_required = sessão pendente (guards.ts
// MFA_ALLOWLIST); após verify a sessão fica não-pendente, por isso o caminho
// de sucesso volta a /me — nunca guardamos a palavra-passe em memória.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { api, ApiError } from "./api";
import type { RegisterInput, Role, SessionUser } from "./types";

export type SessionStatus = "loading" | "anon" | "mfa_setup" | "mfa_required" | "authed";

export interface SessionError {
  title: string;
  detail?: string;
}

interface SessionValue {
  status: SessionStatus;
  user: SessionUser | null;
  otpauthUrl: string | null;
  error: SessionError | null;
  login(email: string, password: string): Promise<void>;
  register(input: RegisterInput): Promise<void>;
  verifyTotp(code: string): Promise<void>;
  logout(): Promise<void>;
}

interface MeResponse {
  id: string;
  name: string;
  email: string;
  role: Role;
}

type LoginResponse =
  | { user: SessionUser; expiresAt: string }
  | { mfa: "setup"; otpauthUrl: string; expiresAt: string }
  | { mfa: "required"; expiresAt: string };

const SessionContext = createContext<SessionValue | null>(null);

function toSessionError(error: unknown): SessionError {
  if (error instanceof ApiError) return { title: error.title, detail: error.detail };
  return { title: "network", detail: "sem ligação ao servidor" };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [error, setError] = useState<SessionError | null>(null);

  // O /me do arranque só transita a partir de 'loading' — uma acção do
  // utilizador (login/verify/logout) que já tenha decidido o estado não é
  // reescrita por uma resposta lenta do boot.
  const statusRef = useRef<SessionStatus>("loading");
  const applyBoot = (next: SessionStatus, nextUser: SessionUser | null): void => {
    if (statusRef.current !== "loading") return;
    statusRef.current = next;
    setUser(nextUser);
    setStatus(next);
  };

  useEffect(() => {
    let alive = true;
    void api.get<MeResponse>("/v1/auth/me").then(
      (me) => {
        if (!alive) return;
        applyBoot("authed", { id: me.id, name: me.name, email: me.email, role: me.role });
        setOtpauthUrl(null);
      },
      (err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 403 && err.title === "mfa_required") {
          applyBoot("mfa_required", null);
        } else {
          applyBoot("anon", null);
        }
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Login e registo devolvem o MESMO contrato (auth.ts): ou dá o utilizador,
  // ou desvia para MFA (setup na criação da conta, required no login de quem
  // já activou o TOTP) — por isso a transição é partilhada.
  const applyAuthResponse = useCallback((result: LoginResponse): void => {
    if ("mfa" in result) {
      setUser(null);
      if (result.mfa === "setup") {
        setOtpauthUrl(result.otpauthUrl);
        statusRef.current = "mfa_setup";
        setStatus("mfa_setup");
      } else {
        setOtpauthUrl(null);
        statusRef.current = "mfa_required";
        setStatus("mfa_required");
      }
      return;
    }
    setOtpauthUrl(null);
    statusRef.current = "authed";
    setUser(result.user);
    setStatus("authed");
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      setError(null);
      try {
        const result = await api.post<LoginResponse>("/v1/auth/login", { email, password });
        applyAuthResponse(result);
      } catch (err) {
        setError(toSessionError(err));
      }
    },
    [applyAuthResponse],
  );

  // Registo público (Onda 1, Task 9): cria empresa + admin e auto-loga com
  // sessão pendente de TOTP — mesmas transições do login.
  const register = useCallback(
    async (input: RegisterInput): Promise<void> => {
      setError(null);
      try {
        const result = await api.post<LoginResponse>("/v1/auth/register", input);
        applyAuthResponse(result);
      } catch (err) {
        setError(toSessionError(err));
      }
    },
    [applyAuthResponse],
  );

  const verifyTotp = useCallback(
    async (code: string): Promise<void> => {
      setError(null);
      try {
        await api.post<{ ok: true }>("/v1/auth/totp/verify", { code });
        const me = await api.get<MeResponse>("/v1/auth/me");
        setOtpauthUrl(null);
        statusRef.current = "authed";
        setUser({ id: me.id, name: me.name, email: me.email, role: me.role });
        setStatus("authed");
      } catch (err) {
        setError(toSessionError(err));
      }
    },
    [],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.post("/v1/auth/logout");
    } catch {
      // rede abaixo ou sessão já morta: o estado local sai de qualquer forma
    }
    statusRef.current = "anon";
    setUser(null);
    setOtpauthUrl(null);
    setError(null);
    setStatus("anon");
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ status, user, otpauthUrl, error, login, register, verifyTotp, logout }),
    [status, user, otpauthUrl, error, login, register, verifyTotp, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (ctx === null) throw new Error("useSession fora do SessionProvider");
  return ctx;
}
