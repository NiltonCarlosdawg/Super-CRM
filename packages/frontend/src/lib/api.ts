// Cliente de API único do frontend (Task 1): todo o fetch passa por aqui.
// Same-origin via proxy do Vite (cookies sem CORS); o cookie `csrf` é ecoado
// no header `x-csrf-token` nas mutações (guard global do backend); erros
// problem+json viram ApiError. Nunca registar corpos (docs/03).

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(detail !== undefined ? `${title}: ${detail}` : title);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  /** Chave lógica do envio — o backend rejeita reutilizações com corpo diferente (409). */
  idempotencyKey?: string;
}

function readCsrfCookie(): string | undefined {
  const match = /(?:^|;\s*)csrf=([^;]*)/.exec(document.cookie);
  return match !== null ? decodeURIComponent(match[1]) : undefined;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: RequestOptions,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") {
    const csrf = readCsrfCookie();
    if (csrf !== undefined) headers["x-csrf-token"] = csrf;
  }
  if (opts?.idempotencyKey !== undefined) {
    headers["idempotency-key"] = opts.idempotencyKey;
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network", "sem ligação ao servidor");
  }

  if (response.status === 204) return undefined as T;

  if (!response.ok) {
    let title = "erro";
    let detail: string | undefined;
    try {
      const problem = (await response.json()) as { title?: string; detail?: string };
      if (typeof problem.title === "string") title = problem.title;
      if (typeof problem.detail === "string") detail = problem.detail;
    } catch {
      // corpo não-JSON: mantém o título genérico (nunca expor corpo cru)
    }
    throw new ApiError(response.status, title, detail);
  }

  return (await response.json()) as T;
}

export const api = {
  get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const query = params === undefined ? "" : `?${new URLSearchParams(params).toString()}`;
    return request<T>("GET", `${path}${query}`);
  },
  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return request<T>("POST", path, body, opts);
  },
  patch<T>(path: string, body: unknown): Promise<T> {
    return request<T>("PATCH", path, body);
  },
  del<T>(path: string): Promise<T> {
    return request<T>("DELETE", path);
  },
};
