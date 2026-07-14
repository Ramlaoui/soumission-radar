import * as pdfjs from "../vendor/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;

const TEXT_EXTENSIONS = new Set(["txt", "md", "csv", "json", "xml", "html", "htm"]);
const MAX_CHARACTERS = 500000;

function extensionFor(name) {
  return String(name || "").split(".").pop()?.toLowerCase() || "";
}

function limitPages(pages) {
  let remaining = MAX_CHARACTERS;
  const output = [];
  for (const page of pages) {
    if (remaining <= 0) break;
    const text = String(page.text || "").slice(0, remaining);
    output.push({ ...page, text });
    remaining -= text.length;
  }
  return output;
}

async function readPdf(file) {
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
  const document = await loadingTask.promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push({ page: pageNumber, text: content.items.map(item => item.str || "").join(" ").replace(/\s+/g, " ").trim() });
    page.cleanup();
  }
  await loadingTask.destroy();
  return pages;
}

export async function readBrowserDocument(file) {
  const extension = extensionFor(file.name);
  const warnings = [];
  let pages;
  if (extension === "pdf") {
    pages = await readPdf(file);
  } else if (extension === "docx") {
    if (!window.mammoth) throw new Error("Le lecteur DOCX n'est pas chargé.");
    const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    pages = [{ page: 1, text: result.value }];
    warnings.push(...result.messages.map(message => `DOCX : ${message.message}`));
  } else if (TEXT_EXTENSIONS.has(extension)) {
    pages = [{ page: 1, text: await file.text() }];
  } else {
    pages = [{ page: 1, text: "" }];
    warnings.push("Image non OCRisée dans le mode local.");
  }
  const limitedPages = limitPages(pages);
  if (limitedPages.reduce((sum, page) => sum + page.text.length, 0) < pages.reduce((sum, page) => sum + page.text.length, 0)) {
    warnings.push("Texte tronqué à 500 000 caractères.");
  }
  return {
    name: file.name,
    relativePath: file.webkitRelativePath || file.name,
    mimeType: file.type,
    size: file.size,
    pages: limitedPages,
    text: limitedPages.map(page => page.text).join("\n"),
    warnings,
    browserFile: file
  };
}
