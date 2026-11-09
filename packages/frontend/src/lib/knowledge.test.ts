import { describe, expect, it } from "vitest";
import { diffLabel, diffTone, docTypeLabel, entityTypeLabel, mediaTypeFor } from "./knowledge";

function file(name: string, type: string): File {
  return new File(["x"], name, { type });
}

describe("mediaTypeFor", () => {
  it("aceita texto e markdown por tipo ou extensão", () => {
    expect(mediaTypeFor(file("a.txt", "text/plain"))).toBe("text/plain");
    expect(mediaTypeFor(file("a.md", ""))).toBe("text/markdown");
    expect(mediaTypeFor(file("a.markdown", "text/markdown"))).toBe("text/markdown");
  });

  it("recusa formatos que o backend não extrai nesta entrega", () => {
    expect(mediaTypeFor(file("a.pdf", "application/pdf"))).toBeNull();
    expect(mediaTypeFor(file("a.png", "image/png"))).toBeNull();
  });
});

describe("rótulos e tons do diff", () => {
  it("cobre as cinco classificações", () => {
    expect(diffLabel("added")).toBe("Novo");
    expect(diffLabel("conflict")).toBe("Conflito");
    expect(diffTone("conflict")).toBe("danger");
    expect(diffTone("added")).toBe("success");
  });

  it("rótulos de entidade e tipo de documento", () => {
    expect(entityTypeLabel("catalog_item")).toBe("Catálogo");
    expect(entityTypeLabel("rule")).toBe("Regra");
    expect(docTypeLabel("company_info")).toBe("Empresa");
  });
});
