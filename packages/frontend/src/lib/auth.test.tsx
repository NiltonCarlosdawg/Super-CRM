// Máquina de estados da sessão (Task 2 do plano do frontend): boot por /me,
// login completo, os DOIS desvios de MFA, verify → /me e logout. Fetch real
// substituído por um handler por URL — os endpoints e corpos são os do backend.

import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, useSession } from "./auth";

const user = { id: "u1", name: "A", email: "a@b.c", role: "admin" as const };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Handler = (url: string, init: RequestInit) => Response;
let handler: Handler;
let calls: Array<{ url: string; init: RequestInit }>;

beforeEach(() => {
  calls = [];
  handler = () => json({ title: "not_found" }, 404);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = { method: "GET" }) => {
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <SessionProvider>{children}</SessionProvider>
);

function setup() {
  return renderHook(() => useSession(), { wrapper });
}

function call(url: string, method = "GET") {
  const found = calls.filter((c) => c.url === url && (c.init.method ?? "GET") === method);
  expect(found.length).toBeGreaterThan(0);
  return found[found.length - 1];
}

describe("session state machine", () => {
  it("me 200 autentica no arranque", async () => {
    handler = (url) => (url === "/v1/auth/me" ? json(user) : json({}, 404));
    const { result } = setup();

    await waitFor(() => expect(result.current.status).toBe("authed"));
    expect(result.current.user).toEqual(user);
  });

  it("me 401 fica anon", async () => {
    handler = (url) =>
      url === "/v1/auth/me" ? json({ title: "unauthenticated", detail: "sessão ausente" }, 401) : json({}, 404);
    const { result } = setup();

    await waitFor(() => expect(result.current.status).toBe("anon"));
    expect(result.current.user).toBeNull();
  });

  it("me 403 mfa_required leva a mfa_required", async () => {
    handler = (url) =>
      url === "/v1/auth/me"
        ? json({ title: "mfa_required", detail: "segundo fator pendente: complete o TOTP" }, 403)
        : json({}, 404);
    const { result } = setup();

    await waitFor(() => expect(result.current.status).toBe("mfa_required"));
    expect(result.current.user).toBeNull();
  });

  it("login completo autentica", async () => {
    handler = (url) => {
      if (url === "/v1/auth/me") return json({ title: "unauthenticated" }, 401);
      if (url === "/v1/auth/login") return json({ user, expiresAt: "2026-10-16T00:00:00.000Z" });
      return json({}, 404);
    };
    const { result } = setup();
    await waitFor(() => expect(result.current.status).toBe("anon"));

    await result.current.login("a@b.c", "pw");

    await waitFor(() => expect(result.current.status).toBe("authed"));
    expect(result.current.user).toEqual(user);
    const loginCall = call("/v1/auth/login", "POST");
    expect(JSON.parse(String(loginCall.init.body))).toEqual({ email: "a@b.c", password: "pw" });
  });

  it("mfa setup com otpauthUrl", async () => {
    handler = (url) => {
      if (url === "/v1/auth/me") return json({ title: "unauthenticated" }, 401);
      if (url === "/v1/auth/login")
        return json({ mfa: "setup", otpauthUrl: "otpauth://totp/X", expiresAt: "2026-10-16T00:00:00.000Z" });
      return json({}, 404);
    };
    const { result } = setup();
    await waitFor(() => expect(result.current.status).toBe("anon"));

    await result.current.login("a@b.c", "pw");

    await waitFor(() => expect(result.current.status).toBe("mfa_setup"));
    expect(result.current.otpauthUrl).toBe("otpauth://totp/X");
    expect(result.current.user).toBeNull();
  });

  it("mfa required sem otpauthUrl", async () => {
    handler = (url) => {
      if (url === "/v1/auth/me") return json({ title: "unauthenticated" }, 401);
      if (url === "/v1/auth/login")
        return json({ mfa: "required", expiresAt: "2026-10-16T00:00:00.000Z" });
      return json({}, 404);
    };
    const { result } = setup();
    await waitFor(() => expect(result.current.status).toBe("anon"));

    await result.current.login("a@b.c", "pw");

    await waitFor(() => expect(result.current.status).toBe("mfa_required"));
    expect(result.current.otpauthUrl).toBeNull();
  });

  it("verifyTotp faz verify e volta pelo /me", async () => {
    let meCalls = 0;
    handler = (url) => {
      if (url === "/v1/auth/me") {
        meCalls += 1;
        return meCalls === 1 ? json({ title: "unauthenticated" }, 401) : json(user);
      }
      if (url === "/v1/auth/login") return json({ mfa: "required", expiresAt: "x" });
      if (url === "/v1/auth/totp/verify") return json({ ok: true });
      return json({}, 404);
    };
    const { result } = setup();
    await waitFor(() => expect(result.current.status).toBe("anon"));
    await result.current.login("a@b.c", "pw");
    await waitFor(() => expect(result.current.status).toBe("mfa_required"));

    await result.current.verifyTotp("123456");

    await waitFor(() => expect(result.current.status).toBe("authed"));
    expect(result.current.user).toEqual(user);
    const verifyCall = call("/v1/auth/totp/verify", "POST");
    expect(JSON.parse(String(verifyCall.init.body))).toEqual({ code: "123456" });
    expect(meCalls).toBe(2); // boot (401) + pós-verify (200)
    const verifyIndex = calls.findIndex((c) => c.url === "/v1/auth/totp/verify");
    const meIndex = calls.map((c) => c.url).lastIndexOf("/v1/auth/me");
    expect(verifyIndex).toBeLessThan(meIndex);
  });

  it("verifyTotp invalido mostra erro e não sai do mfa", async () => {
    handler = (url) => {
      if (url === "/v1/auth/me") return json({ title: "unauthenticated" }, 401);
      if (url === "/v1/auth/login") return json({ mfa: "required", expiresAt: "x" });
      if (url === "/v1/auth/totp/verify")
        return json({ title: "invalid_code", detail: "código TOTP inválido" }, 400);
      return json({}, 404);
    };
    const { result } = setup();
    await waitFor(() => expect(result.current.status).toBe("anon"));
    await result.current.login("a@b.c", "pw");
    await waitFor(() => expect(result.current.status).toBe("mfa_required"));

    await result.current.verifyTotp("000000");

    expect(result.current.status).toBe("mfa_required");
    await waitFor(() =>
      expect(result.current.error).toMatchObject({ title: "invalid_code", detail: "código TOTP inválido" }),
    );
    expect(result.current.status).toBe("mfa_required");
  });

  it("logout volta a anon", async () => {
    handler = (url) => {
      if (url === "/v1/auth/me") return json(user);
      if (url === "/v1/auth/logout") return new Response(null, { status: 204 });
      return json({}, 404);
    };
    const { result } = setup();
    await waitFor(() => expect(result.current.status).toBe("authed"));

    await result.current.logout();

    await waitFor(() => expect(result.current.status).toBe("anon"));
    expect(result.current.user).toBeNull();
    expect(result.current.error).toBeNull();
    expect(call("/v1/auth/logout", "POST").url).toBe("/v1/auth/logout");
  });
});
