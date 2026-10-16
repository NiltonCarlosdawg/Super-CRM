import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Com globals:false o RTL não regista o cleanup sozinho — sem isto o DOM
// acumula entre testes e o query de um teste encontra o do anterior.
afterEach(() => {
  cleanup();
});
