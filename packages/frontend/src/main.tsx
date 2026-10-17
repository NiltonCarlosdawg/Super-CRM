// Fontes self-hosted (desenho §3): igual à referência, sem CDNs de terceiros.
import "@fontsource/outfit/400.css";
import "@fontsource/outfit/500.css";
import "@fontsource/ibm-plex-sans/300.css";
import "@fontsource/ibm-plex-sans/400.css";

import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { SessionProvider } from "./lib/auth";
import { AppShell } from "./components/AppShell";
import { RequireAdmin, RequireAuth } from "./components/guards";
import { ToastProvider } from "./components/ui/Toast";

import LoginPage from "./pages/login";
import RegisterPage from "./pages/register";
import DashboardPage from "./pages/dashboard";
import AccountsPage from "./pages/accounts";
import ConversationsPage from "./pages/conversations";
import CampaignsPage from "./pages/campaigns";
import UsersPage from "./pages/users";

import "./globals.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <SessionProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route element={<RequireAuth><AppShell /></RequireAuth>}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/accounts" element={<AccountsPage />} />
              <Route path="/conversations" element={<ConversationsPage />} />
              <Route path="/conversations/:id" element={<ConversationsPage />} />
              <Route path="/campaigns" element={<CampaignsPage />} />
              <Route
                path="/users"
                element={<RequireAdmin><UsersPage /></RequireAdmin>}
              />
            </Route>
          </Routes>
        </BrowserRouter>
      </SessionProvider>
    </ToastProvider>
  </React.StrictMode>,
);
