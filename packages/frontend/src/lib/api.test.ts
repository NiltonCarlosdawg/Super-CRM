// Testes do cliente de API (Task 1 do plano do frontend): CSRF, problem+json,
// GET sem CSRF e 204. Todos com fetch substituído — a rede nunca sai daqui.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headersOf(call: unknown[]): Record<string, string> {
  const init = call[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

describe("api client", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    document.cookie = "csrf=abc123";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = "csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  });

  it("envia x-csrf-token nas mutações", async () => {
    await api.post("/v1/x", { a: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = headersOf(fetchMock.mock.calls[0]);
    expect(headers["x-csrf-token"]).toBe("abc123");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("mapeia problem+json para ApiError", async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ title: "validation_failed", detail: "x" }, 400),
    );

    const attempt = api.post("/v1/x", {});

    await expect(attempt).rejects.toBeInstanceOf(ApiError);
    await expect(attempt).rejects.toMatchObject({
      status: 400,
      title: "validation_failed",
      detail: "x",
    });
  });

  it("GET sem header csrf", async () => {
    await api.get("/v1/x");

    const headers = headersOf(fetchMock.mock.calls[0]);
    expect(headers["x-csrf-token"]).toBeUndefined();
  });

  it("204 resolve sem corpo", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 204 }));

    await expect(api.del("/v1/x")).resolves.toBeUndefined();
  });
});
