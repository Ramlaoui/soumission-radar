import { readBrowserDocument } from "./lib/browser_document_reader.mjs";

const config = window.SoumissionRadarConfig || {};
const analyzer = window.SubmissionDaoAnalyzer;
const ledgerBuilder = window.SubmissionLedger;
const apiBaseUrl = String(config.apiBaseUrl || "").replace(/\/$/, "");

let selectedDao = null;
let selectedDocuments = [];
let extractedDocuments = [];
let activeCase = null;
let caseToken = null;

const element = id => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function slugify(value) {
  return String(value || "dossier")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70) || "dossier";
}

function formatBytes(bytes) {
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
}

function setSetupError(message) {
  element("setupError").textContent = message;
  element("setupError").classList.toggle("hidden", !message);
}

async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (caseToken) headers.set("x-case-token", caseToken);
  const response = await fetch(`${apiBaseUrl}${path}`, { ...options, headers });
  if (!response.ok) {
    let message = `Erreur ${response.status}`;
    try { message = (await response.json()).error || message; } catch { /* response is not JSON */ }
    throw new Error(message);
  }
  return response;
}

function updateFileLabels() {
  element("daoFileName").textContent = selectedDao ? `${selectedDao.name} · ${formatBytes(selectedDao.size)}` : "Aucun DAO sélectionné";
  const total = selectedDocuments.reduce((sum, file) => sum + file.size, 0);
  element("companyFileSummary").textContent = selectedDocuments.length
    ? `${selectedDocuments.length} pièce${selectedDocuments.length > 1 ? "s" : ""} · ${formatBytes(total)}`
    : "Aucune pièce sélectionnée";
}

async function createLocalCase(title, buyer) {
  const dao = await readBrowserDocument(selectedDao);
  extractedDocuments = await Promise.all(selectedDocuments.map(readBrowserDocument));
  const analysis = analyzer.analyzeDao({ pages: dao.pages });
  const ledger = ledgerBuilder.buildLedger({ dao: analysis, documents: extractedDocuments, title, buyer });
  return {
    id: `local-${crypto.randomUUID()}`,
    createdAt: ledger.generatedAt,
    updatedAt: ledger.generatedAt,
    expiresAt: null,
    title,
    buyer,
    mode: "local-evidence",
    dao: [{ name: dao.name, size: dao.size, warnings: dao.warnings }],
    documents: extractedDocuments.map(document => ({ name: document.name, size: document.size, warnings: document.warnings })),
    ledger,
    aiReview: null,
    messages: []
  };
}

async function createRemoteCase(title, buyer) {
  const form = new FormData();
  form.append("title", title);
  form.append("buyer", buyer);
  form.append("dao", selectedDao, selectedDao.name);
  for (const file of selectedDocuments) form.append("documents", file, file.name);
  const accessCode = element("accessCode").value;
  const response = await apiRequest("/api/cases", {
    method: "POST",
    headers: accessCode ? { "x-access-code": accessCode } : {},
    body: form
  });
  const payload = await response.json();
  caseToken = payload.caseToken;
  return payload.case;
}

async function analyzeCase(event) {
  event.preventDefault();
  if (!selectedDao) return setSetupError("Ajoutez le DAO avant de construire le registre.");
  if (selectedDocuments.length > 30) return setSetupError("Ajoutez au maximum 30 pièces d'entreprise.");
  const total = [selectedDao, ...selectedDocuments].reduce((sum, file) => sum + file.size, 0);
  if (total > 50 * 1024 * 1024) return setSetupError("Le dossier dépasse la limite de 50 Mo.");

  const button = element("analyzeCase");
  button.disabled = true;
  button.textContent = "Lecture du DAO…";
  setSetupError("");
  try {
    const title = element("caseTitle").value.trim() || selectedDao.name.replace(/\.[^.]+$/, "");
    const buyer = element("caseBuyer").value.trim();
    activeCase = apiBaseUrl ? await createRemoteCase(title, buyer) : await createLocalCase(title, buyer);
    renderWorkspace();
    element("caseSetup").classList.add("hidden");
    element("analysisWorkspace").classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    setSetupError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Construire le registre →";
  }
}

function statusPresentation(status) {
  if (status === "not_ready") return {
    badge: "Blocages",
    badgeClass: "bg-rose-100 text-rose-800",
    title: "Le dossier n'est pas prêt.",
    copy: "Des exigences extraites n'ont pas encore de pièce correspondante. Traitez-les avant toute revue finale."
  };
  if (status === "needs_review") return {
    badge: "À relire",
    badgeClass: "bg-amber-100 text-amber-800",
    title: "Les pièces sont là, certaines restent à confirmer.",
    copy: "Le registre a trouvé une pièce par exigence, mais des versions, dates ou noms de fichiers nécessitent une revue humaine."
  };
  return {
    badge: "Revue finale",
    badgeClass: "bg-emerald-100 text-emerald-800",
    title: "Le dossier peut passer en revue finale.",
    copy: "Chaque exigence extraite a une pièce associée. Vérifiez encore contenu, dates, signatures, additifs et canal de dépôt."
  };
}

function factPage(fact) {
  return fact?.evidence?.length ? `Source : DAO p. ${fact.evidence.map(item => item.page).join(", ")}` : "Source non établie";
}

function renderFact(valueId, pageId, fact) {
  element(valueId).textContent = fact?.value || "Non détecté";
  element(pageId).textContent = factPage(fact);
}

function rowStatus(row) {
  if (row.status === "missing") return { label: "Manquante", className: "bg-rose-100 text-rose-800", dot: "bg-rose-500" };
  if (row.status === "needs_review") return { label: "À relire", className: "bg-amber-100 text-amber-800", dot: "bg-amber-500" };
  return { label: "Trouvée", className: "bg-emerald-100 text-emerald-800", dot: "bg-emerald-500" };
}

function renderLedger() {
  const rows = activeCase.ledger.rows;
  element("ledgerCount").textContent = `${rows.length} exigence${rows.length > 1 ? "s" : ""} extraite${rows.length > 1 ? "s" : ""}`;
  element("ledgerRows").innerHTML = rows.length ? rows.map(row => {
    const status = rowStatus(row);
    const documents = row.documents.length
      ? row.documents.map(document => `<span class="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">${escapeHtml(document.name)}</span>`).join("")
      : '<span class="text-xs font-semibold text-rose-700">Aucune pièce associée</span>';
    const evidence = row.evidence.length
      ? row.evidence.map(item => `<blockquote class="mt-2 border-l-2 border-emerald-300 pl-3 text-xs leading-5 text-slate-500"><strong class="text-emerald-800">DAO p. ${item.page}</strong> — ${escapeHtml(item.quote)}</blockquote>`).join("")
      : '<p class="mt-2 text-xs text-amber-700">Citation exacte indisponible.</p>';
    return `<article class="rounded-2xl border border-slate-900/8 p-4 sm:p-5">
      <div class="flex flex-wrap items-start justify-between gap-3"><div class="flex min-w-0 items-start gap-3"><span class="mt-1.5 size-2.5 shrink-0 rounded-full ${status.dot}"></span><div><h3 class="font-black text-slate-950">${escapeHtml(row.label)}</h3><p class="mt-1 text-xs text-slate-400">${row.matched}/${row.expected} pièce${row.expected > 1 ? "s" : ""} · confiance ${escapeHtml(row.confidence)}</p></div></div><span class="rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-[.1em] ${status.className}">${status.label}</span></div>
      <div class="mt-4 flex flex-wrap gap-2">${documents}</div>
      <details class="mt-4 rounded-xl bg-[#f7f7f4] p-3"><summary class="cursor-pointer text-xs font-black text-slate-700">Voir la preuve dans le DAO</summary>${evidence}</details>
      <p class="mt-3 text-xs leading-5 text-slate-600"><strong>Action :</strong> ${escapeHtml(row.action)}</p>
    </article>`;
  }).join("") : '<div class="rounded-2xl bg-amber-50 p-5 text-sm text-amber-900">Aucune exigence fiable n’a été extraite. Le DAO peut être un scan : utilisez une version OCR ou la seconde lecture sur invitation.</div>';
}

function renderAiReview() {
  const review = activeCase.aiReview;
  element("aiReviewSection").classList.toggle("hidden", !review);
  if (!review) return;
  element("aiReviewSummary").textContent = review.summary;
  element("aiReviewRisks").innerHTML = review.risks.length ? review.risks.map(risk => {
    const citations = risk.citations.map(citation => `${escapeHtml(citation.document)} p. ${citation.page}`).join(" · ");
    return `<article class="rounded-2xl bg-white/70 p-4"><div class="flex gap-2"><span class="rounded-full bg-blue-100 px-2 py-1 text-[10px] font-black uppercase text-blue-800">${escapeHtml(risk.severity)}</span><h3 class="font-black">${escapeHtml(risk.title)}</h3></div><p class="mt-2 text-sm leading-6 text-slate-600">${escapeHtml(risk.explanation)}</p>${citations ? `<p class="mt-2 text-xs font-bold text-blue-700">${citations}</p>` : ""}</article>`;
  }).join("") : '<p class="text-sm text-slate-500">Aucun risque supplémentaire conservé après contrôle des citations.</p>';
}

function messageHtml(message) {
  const isUser = message.role === "user";
  const citations = message.citations?.length
    ? `<div class="mt-2 space-y-1">${message.citations.map(citation => `<p class="rounded-lg bg-black/10 px-2 py-1.5 text-[10px] leading-4">${escapeHtml(citation.document)} p. ${citation.page} — « ${escapeHtml(citation.quote)} »</p>`).join("")}</div>`
    : "";
  return `<div class="${isUser ? "ml-8" : "mr-4"}"><div class="rounded-2xl ${isUser ? "rounded-br-sm bg-lime-300 text-slate-950" : "rounded-bl-sm bg-white/8 text-slate-200"} px-3.5 py-3 text-sm leading-6"><p class="whitespace-pre-wrap">${escapeHtml(message.content)}</p>${citations}</div><p class="mt-1 px-1 text-[9px] font-bold uppercase tracking-[.12em] text-slate-600">${isUser ? "Vous" : message.mode?.startsWith("openai") ? "Copilote modèle" : "Moteur de preuves"}</p></div>`;
}

function renderMessages() {
  const messages = activeCase.messages || [];
  const welcome = {
    role: "assistant",
    mode: activeCase.mode,
    content: `Registre construit : ${activeCase.ledger.coverage.matched}/${activeCase.ledger.coverage.expected} pièces reliées. Je réponds à partir des preuves de ce dossier. Par quoi voulez-vous commencer ?`
  };
  element("chatMessages").innerHTML = [welcome, ...messages].map(messageHtml).join("");
  element("chatMessages").scrollTop = element("chatMessages").scrollHeight;
}

function renderWorkspace() {
  const ledger = activeCase.ledger;
  const status = statusPresentation(ledger.status);
  element("workspaceTitle").textContent = activeCase.title;
  element("workspaceBuyer").textContent = activeCase.buyer || "Acheteur non renseigné";
  element("statusBadge").textContent = status.badge;
  element("statusBadge").className = `rounded-full px-3 py-1 text-xs font-black uppercase tracking-[.12em] ${status.badgeClass}`;
  element("statusTitle").textContent = status.title;
  element("statusCopy").textContent = status.copy;
  element("modelMode").textContent = activeCase.mode.startsWith("openai") ? "Seconde lecture activée" : "Moteur local vérifiable";
  element("coveragePercent").textContent = `${ledger.coverage.percent} %`;
  element("coverageRatio").textContent = `${ledger.coverage.matched}/${ledger.coverage.expected}`;
  element("coverageProgress").value = ledger.coverage.percent;
  renderFact("factDeadline", "factDeadlinePage", ledger.facts.deadline);
  renderFact("factSecurity", "factSecurityPage", ledger.facts.bidSecurity);
  renderFact("factValidity", "factValidityPage", ledger.facts.validity);
  renderFact("factSubmission", "factSubmissionPage", ledger.facts.submissionMode);
  const importantWarnings = ledger.warnings.filter(warning => !warning.startsWith("Le registre assiste"));
  element("warningBanner").classList.toggle("hidden", importantWarnings.length === 0);
  element("warningBanner").textContent = importantWarnings.join(" ");
  element("securityBanner").classList.toggle("hidden", !ledger.security.promptInjectionDetected);
  element("securityBanner").textContent = ledger.security.promptInjectionDetected
    ? `${ledger.security.findings.length} instruction suspecte trouvée dans le document : isolée et ignorée.`
    : "";
  renderLedger();
  renderAiReview();
  renderMessages();
}

async function sendQuestion(question) {
  const value = String(question || "").trim();
  if (!value || !activeCase) return;
  element("chatInput").value = "";
  const pendingUser = { role: "user", content: value };
  activeCase.messages = [...(activeCase.messages || []), pendingUser];
  renderMessages();
  element("sendMessage").disabled = true;
  try {
    if (apiBaseUrl) {
      activeCase.messages.pop();
      const response = await apiRequest(`/api/cases/${activeCase.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: value })
      });
      activeCase = (await response.json()).case;
    } else {
      activeCase.messages.push(ledgerBuilder.answerQuestion(activeCase.ledger, value));
    }
  } catch (error) {
    activeCase.messages.push({ role: "assistant", content: `Je n'ai pas pu répondre : ${error.message}`, mode: "error" });
  } finally {
    element("sendMessage").disabled = false;
    renderMessages();
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function downloadLocalPackage() {
  const zip = new window.JSZip();
  zip.file(`00_DAO/${selectedDao.name}`, selectedDao);
  const included = new Set();
  for (const row of activeCase.ledger.rows) {
    for (const mapped of row.documents) {
      const document = extractedDocuments.find(item => item.name === mapped.name);
      if (!document) continue;
      zip.file(mapped.output, document.browserFile);
      included.add(document.name);
    }
    if (row.status === "missing") zip.file(`98_PIECES_MANQUANTES/${row.id.toUpperCase()}.md`, `# Pièce manquante : ${row.label}\n\n${row.action}\n`);
  }
  for (const document of extractedDocuments) {
    if (!included.has(document.name)) zip.file(`99_NON_CLASSES/${document.name}`, document.browserFile);
  }
  zip.file("01_REGISTRE_CONFORMITE.md", `${ledgerBuilder.toMarkdown(activeCase.ledger)}\n`);
  zip.file("01_REGISTRE_CONFORMITE.json", `${JSON.stringify(activeCase.ledger, null, 2)}\n`);
  zip.file("02_PLAN_ACTIONS.md", `${ledgerBuilder.actionPlanMarkdown(activeCase.ledger)}\n`);
  zip.file("LISEZ_MOI.md", "# Revue finale obligatoire\n\nLe DAO original et la validation humaine prévalent. Ce registre ne garantit ni la recevabilité ni l'attribution.\n");
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  downloadBlob(blob, `soumission-${slugify(activeCase.title)}.zip`);
}

async function downloadFinalPackage() {
  const button = element("downloadFinal");
  button.disabled = true;
  button.textContent = "Préparation…";
  try {
    if (!apiBaseUrl) return await downloadLocalPackage();
    const response = await apiRequest(`/api/cases/${activeCase.id}/final-ledger.zip`);
    downloadBlob(await response.blob(), `soumission-${slugify(activeCase.title)}.zip`);
  } catch (error) {
    window.alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Télécharger le dossier final";
  }
}

async function resetCase(removeRemote) {
  if (removeRemote && apiBaseUrl && activeCase) {
    try { await apiRequest(`/api/cases/${activeCase.id}`, { method: "DELETE" }); }
    catch (error) { window.alert(`Suppression distante impossible : ${error.message}`); return; }
  }
  selectedDao = null;
  selectedDocuments = [];
  extractedDocuments = [];
  activeCase = null;
  caseToken = null;
  element("daoFile").value = "";
  element("companyFiles").value = "";
  element("caseTitle").value = "";
  element("caseBuyer").value = "";
  updateFileLabels();
  element("analysisWorkspace").classList.add("hidden");
  element("caseSetup").classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function loadDemo() {
  const daoText = [
    "APPEL D'OFFRES — Maintenance informatique des centres municipaux.",
    "Les offres devront être soumises au plus tard le 30 juillet 2026 à 10h00 sous pli fermé au secrétariat.",
    "Le candidat joindra son NINEA et son RCCM, un quitus fiscal et social, une lettre de soumission signée et une garantie de soumission de 750 000 FCFA.",
    "L'offre restera valide pendant 90 jours. L'offre technique présentera la méthodologie et le personnel clé.",
    "L'offre financière inclura le bordereau des prix. Le candidat justifiera au moins 3 références similaires avec attestations de bonne exécution."
  ].join("\n\n");
  selectedDao = new File([daoText], "dao-maintenance-informatique.txt", { type: "text/plain" });
  selectedDocuments = [
    new File(["NINEA et RCCM — Baobab Numérique"], "ninea-rccm-baobab.txt", { type: "text/plain" }),
    new File(["Quitus fiscal et social valide"], "quitus-fiscal-social.txt", { type: "text/plain" }),
    new File(["Lettre de soumission signée"], "lettre-soumission-signee.txt", { type: "text/plain" }),
    new File(["Mémoire technique — méthodologie et planning"], "memoire-technique.txt", { type: "text/plain" }),
    new File(["CV et diplômes du personnel clé"], "personnel-cle-cv.txt", { type: "text/plain" }),
    new File(["Bordereau de prix brouillon à relire"], "bordereau-prix-brouillon.txt", { type: "text/plain" }),
    new File(["Référence similaire — Hôpital principal"], "reference-hopital.txt", { type: "text/plain" }),
    new File(["Référence similaire — Ville de Thiès"], "reference-thies.txt", { type: "text/plain" })
  ];
  element("caseTitle").value = "Maintenance informatique des centres municipaux";
  element("caseBuyer").value = "Ville de Démonstration";
  updateFileLabels();
  element("caseForm").requestSubmit();
}

function initialize() {
  if (!analyzer || !ledgerBuilder || !window.JSZip) {
    setSetupError("Les modules de l'atelier n'ont pas pu être chargés.");
    return;
  }
  if (apiBaseUrl) {
    element("modeBadge").textContent = "Serveur privé · suppression 24 h";
    element("accessCodeField").classList.remove("hidden");
    element("privacyNote").textContent = "Mode serveur privé : fichiers isolés par dossier et supprimés automatiquement après 24 h. Utilisez une adresse HTTPS hors réseau local.";
  }
  element("daoFile").addEventListener("change", event => { selectedDao = event.target.files[0] || null; updateFileLabels(); });
  element("companyFiles").addEventListener("change", event => { selectedDocuments = [...event.target.files]; updateFileLabels(); });
  element("caseForm").addEventListener("submit", analyzeCase);
  element("demoButton").addEventListener("click", loadDemo);
  element("chatForm").addEventListener("submit", event => { event.preventDefault(); sendQuestion(element("chatInput").value); });
  element("quickQuestions").addEventListener("click", event => { const question = event.target.closest("[data-question]")?.dataset.question; if (question) sendQuestion(question); });
  element("downloadFinal").addEventListener("click", downloadFinalPackage);
  element("deleteCaseButton").addEventListener("click", () => resetCase(true));
  element("newCaseButton").addEventListener("click", () => resetCase(true));
  updateFileLabels();
}

document.addEventListener("DOMContentLoaded", initialize);
