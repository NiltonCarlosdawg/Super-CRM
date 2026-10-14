import { cookies } from "next/headers";
import type { AIProvider, AIRequest, AIResponse } from "@/src/ports/ai-provider";

export type User = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "editor" | "agent";
  company?: string;
};

export type AuthStatus = {
  isAuthenticated: boolean;
  user: User | null;
  token: string | null;
};

/**
 * Fetch helper with auth headers
 */
async function apiFetch(path: string, options: RequestInit = {}) {
  const cookieStore = cookies();
  const token = cookieStore.get("token")?.value;

  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000"}/api${path}`, {
    headers,
    ...options,
  });

  // Refresh token on 401
  if (res.status === 401) {
    // TODO: implement token refresh flow
    // await apiFetch("/api/auth/refresh", { method: "POST" });
  }

  return res;
}

/**
 * Auth functions
 */
export async function login(email: string, senha: string) {
  const res = await apiFetch("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, senha }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Login failed");
  }

  const data = await res.json();
  // Store token in cookie
  const ck = cookies();
  ck.set("token", data.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });

  return data.user as User;
}

export async function register(name: string, email: string, senha: string) {
  const res = await apiFetch("/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, senha }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Registration failed");
  }

  const data = await res.json();
  const ck = cookies();
  ck.set("token", data.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  return data.user as User;
}

export async function logout() {
  const ck = cookies();
  ck.set("token", "", {
    httpOnly: true,
    secure: false,
    path: "/",
    maxAge: 0,
  });
  await apiFetch("/auth/logout", { method: "POST" });
}

export async function getCurrentUser() => {
  const ck = cookies();
  const token = ck.get("token")?.value;

  if (!token) {
    return { isAuthenticated: false, user: null };
  }

  const res = await apiFetch("/auth/me", { method: "GET" });

  if (!res.ok) {
    // Clear invalid token
    logout();
    return { isAuthenticated: false, user: null };
  }

  const user = await res.json() as User;
  return { isAuthenticated: true, user };
};

/**
 * API shortcuts for dashboard resources
 */
export async function getDashboardStats() {
  const res = await apiFetch("/dashboard/stats", { method: "GET" });
  if (!res.ok) throw new Error("Failed to fetch dashboard stats");
  return res.json();
}

export async function getConversations({ page = 1, limit = 20, status }: {
  page?: number;
  limit?: number;
  status?: string;
}) {
  const res = await apiFetch(
    `/conversations?page=${page}&limit=${limit}&status=${status || ""}`,
    { method: "GET" }
  );
  if (!res.ok) throw new Error("Failed to fetch conversations");
  return res.json();
}

export async function getAccounts() {
  const res = await apiFetch("/accounts", { method: "GET" });
  if (!res.ok) throw new Error("Failed to fetch accounts");
  return res.json();
}

export async function getCampaigns() {
  const res = await apiFetch("/campaigns", { method: "GET" });
  if (!res.ok) throw new Error("Failed to fetch campaigns");
  return res.json();
}