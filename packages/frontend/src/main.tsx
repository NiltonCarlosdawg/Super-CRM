// Fontes self-hosted (desenho §3): igual à referência, sem CDNs de terceiros.
import "@fontsource/outfit/400.css";
import "@fontsource/outfit/500.css";
import "@fontsource/ibm-plex-sans/300.css";
import "@fontsource/ibm-plex-sans/400.css";

import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";

import HomePage from "./pages/index";
import AccountsPage from "./pages/accounts";
import CampaignsPage from "./pages/campaigns";
import LoginPage from "./pages/login";
import RegisterPage from "./pages/register";

import "./globals.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/campaigns" element={<CampaignsPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);