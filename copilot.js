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
let accountMode = false;
let accountConfig = null;
let accountSession = null;
let activeWorkspace = null;
let activeFeedback = null;
let vaultDocuments = [];
let vaultUsage = null;
const selectedVaultIds = new Set();

const VAULT_CATEGORY_LABELS = {
  legal: "Juridique",
  tax_social: "Fiscal & social",
  bank: "Banque",
  references: "Références",
  staff: "Personnel",
  technical: "Technique",
  financial: "Financier",
  other: "Autre"
};

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

function randomUuid() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
  if (!accountMode && caseToken) headers.set("x-case-token", caseToken);
  const method = String(options.method || "GET").toUpperCase();
  if (accountMode && !["GET", "HEAD", "OPTIONS"].includes(method) && !path.startsWith("/api/auth/login") && !path.startsWith("/api/auth/register")) {
    const csrf = document.cookie.split("; ").find(item => item.startsWith("sr_csrf="))?.split("=").slice(1).join("=");
    if (csrf) headers.set("x-csrf-token", decodeURIComponent(csrf));
  }
  const response = await fetch(`${apiBaseUrl}${path}`, { credentials: "same-origin", ...options, headers });
  if (!response.ok) {
    let message = `Erreur ${response.status}`;
    let payload = {};
    try { payload = await response.json(); message = payload.error || message; } catch { /* response is not JSON */ }
    const error = new Error(message);
    error.status = response.status;
    error.code = payload.code;
    error.workspaceId = payload.workspaceId;
    throw error;
  }
  return response;
}

function updateFileLabels() {
  element("daoFileName").textContent = selectedDao ? `${selectedDao.name} · ${formatBytes(selectedDao.size)}` : "Aucun DAO sélectionné";
  const total = selectedDocuments.reduce((sum, file) => sum + file.size, 0)
    + vaultDocuments.filter(document => selectedVaultIds.has(document.id)).reduce((sum, document) => sum + document.size, 0);
  const vaultCount = selectedVaultIds.size;
  element("companyFileSummary").textContent = selectedDocuments.length || vaultCount
    ? `${selectedDocuments.length} fichier${selectedDocuments.length > 1 ? "s" : ""}${vaultCount ? ` + ${vaultCount} du coffre` : ""} · ${formatBytes(total)}`
    : "Aucune pièce sélectionnée";
}

async function createLocalCase(title, buyer) {
  const dao = await readBrowserDocument(selectedDao);
  extractedDocuments = await Promise.all(selectedDocuments.map(readBrowserDocument));
  const analysis = analyzer.analyzeDao({ pages: dao.pages });
  const ledger = ledgerBuilder.buildLedger({ dao: analysis, documents: extractedDocuments, title, buyer });
  return {
    id: `local-${randomUuid()}`,
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
  if (accountMode && selectedVaultIds.size) form.append("vaultDocumentIds", JSON.stringify([...selectedVaultIds]));
  const endpoint = accountMode ? "/api/workspaces" : "/api/cases";
  const accessCode = element("accessCode").value;
  const response = await apiRequest(endpoint, {
    method: "POST",
    headers: accountMode
      ? { "x-idempotency-key": randomUuid() }
      : accessCode ? { "x-access-code": accessCode } : {},
    body: form
  });
  const payload = await response.json();
  if (accountMode) {
    activeWorkspace = payload.workspace;
    activeFeedback = payload.feedback || null;
    if (!payload.case && payload.job) {
      await waitForAgentJob(payload.job.id, {
        build: true,
        onProgress: job => {
          const button = element("analyzeCase");
          button.textContent = `${job.status_message || "Analyse sécurisée"} · ${job.progress || 0} %`;
        }
      });
      const completed = await apiRequest(`/api/workspaces/${activeWorkspace.id}`);
      const completedPayload = await completed.json();
      activeWorkspace = completedPayload.workspace;
      activeFeedback = completedPayload.feedback || null;
      return completedPayload.case;
    }
  } else {
    caseToken = payload.caseToken;
  }
  return payload.case;
}

async function analyzeCase(event) {
  event.preventDefault();
  if (!selectedDao) return setSetupError("Ajoutez le DAO avant de construire le registre.");
  if (selectedDocuments.length + selectedVaultIds.size > 30) return setSetupError("Ajoutez au maximum 30 pièces d'entreprise, coffre inclus.");
  const selectedVaultBytes = vaultDocuments.filter(document => selectedVaultIds.has(document.id)).reduce((sum, document) => sum + document.size, 0);
  const total = [selectedDao, ...selectedDocuments].reduce((sum, file) => sum + file.size, 0) + selectedVaultBytes;
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
    if (accountMode) {
      element("accountHomeButton").classList.remove("hidden");
      refreshAccountSession().catch(() => {});
    }
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

function renderPilotFeedback() {
  const visible = accountMode && Boolean(activeWorkspace);
  element("pilotFeedbackSection").classList.toggle("hidden", !visible);
  if (!visible) return;
  const feedback = activeFeedback;
  element("feedbackOrganization").value = feedback?.organizationName || "";
  element("feedbackRole").value = feedback?.practitionerRole || "pme";
  element("feedbackScore").value = String(feedback?.valueScore || 5);
  element("feedbackWouldPay").value = feedback?.wouldPay || "yes";
  element("feedbackRepeat").checked = Boolean(feedback?.repeatIntent);
  element("feedbackMinutes").value = feedback?.minutesToValue || "";
  element("feedbackBlocker").value = feedback?.blocker || "";
  element("feedbackMessage").textContent = feedback ? "Retour enregistré. Vous pouvez le modifier." : "";
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
  renderPilotFeedback();
  renderMessages();
}

async function submitPilotFeedback(event) {
  event.preventDefault();
  if (!accountMode || !activeWorkspace) return;
  const button = element("feedbackSubmit");
  button.disabled = true;
  element("feedbackMessage").textContent = "Enregistrement…";
  try {
    const minutes = element("feedbackMinutes").value;
    const response = await apiRequest(`/api/workspaces/${activeWorkspace.id}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        organizationName: element("feedbackOrganization").value,
        practitionerRole: element("feedbackRole").value,
        valueScore: Number(element("feedbackScore").value),
        wouldPay: element("feedbackWouldPay").value,
        repeatIntent: element("feedbackRepeat").checked,
        minutesToValue: minutes ? Number(minutes) : null,
        blocker: element("feedbackBlocker").value
      })
    });
    activeFeedback = (await response.json()).feedback;
    element("feedbackMessage").textContent = "Merci — retour enregistré.";
  } catch (error) {
    element("feedbackMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
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
    if (accountMode) {
      activeCase.messages.pop();
      const response = await apiRequest(`/api/workspaces/${activeWorkspace.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-idempotency-key": randomUuid() },
        body: JSON.stringify({ message: value })
      });
      const queued = await response.json();
      await waitForAgentJob(queued.job.id);
      await loadWorkspace(activeWorkspace.id, { keepPosition: true });
    } else if (apiBaseUrl) {
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

async function waitForAgentJob(jobId, { build = false, onProgress = () => {} } = {}) {
  const maxAttempts = build ? 3600 : 180;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await apiRequest(`/api/jobs/${jobId}`);
    const { job } = await response.json();
    onProgress(job);
    if (job.status === "succeeded") return job;
    if (["failed", "cancelled"].includes(job.status)) {
      throw new Error(build
        ? "L'analyse n'a pas abouti. Le crédit dossier a été automatiquement restitué; vous pouvez réessayer."
        : "Le copilote n'a pas terminé cette demande. Votre quota n'a pas été débité.");
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Le traitement continue en arrière-plan. Revenez dans quelques instants.");
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
    const path = accountMode
      ? `/api/workspaces/${activeWorkspace.id}/final-ledger.zip`
      : `/api/cases/${activeCase.id}/final-ledger.zip`;
    const response = await apiRequest(path);
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
    const path = accountMode ? `/api/workspaces/${activeWorkspace.id}` : `/api/cases/${activeCase.id}`;
    try { await apiRequest(path, { method: "DELETE" }); }
    catch (error) { window.alert(`Suppression distante impossible : ${error.message}`); return; }
  }
  selectedDao = null;
  selectedDocuments = [];
  selectedVaultIds.clear();
  extractedDocuments = [];
  activeCase = null;
  activeWorkspace = null;
  activeFeedback = null;
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
  selectedVaultIds.clear();
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

function setAccountError(message) {
  element("accountError").textContent = message;
  element("accountError").classList.toggle("hidden", !message);
}

function showAuthForm(kind) {
  const login = kind === "login";
  element("loginForm").classList.toggle("hidden", !login);
  element("registerForm").classList.toggle("hidden", login);
  element("showLogin").className = `flex-1 rounded-lg px-4 py-2.5 ${login ? "bg-white shadow-sm" : "text-slate-500"}`;
  element("showRegister").className = `flex-1 rounded-lg px-4 py-2.5 ${login ? "text-slate-500" : "bg-white shadow-sm"}`;
  setAccountError("");
}

function showOnly(sectionId) {
  for (const id of ["accountGate", "accountDashboard", "caseSetup", "analysisWorkspace"]) {
    element(id).classList.toggle("hidden", id !== sectionId);
  }
}

function formatDate(value) {
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

function planUsageText(plan) {
  if (plan.code === "dossier") return `1 dossier · ${plan.agentTurnLimit} échanges · ${plan.retentionDays} jours`;
  return `${plan.workspaceLimit} dossiers/mois · ${plan.agentTurnLimit} échanges · ${plan.concurrentAgentRuns} traitements simultanés`;
}

async function refreshAccountSession() {
  const response = await apiRequest("/api/auth/me");
  accountSession = await response.json();
  if (!accountSession.user) {
    const error = new Error("Connectez-vous pour continuer.");
    error.status = 401;
    throw error;
  }
  return accountSession;
}

async function renderAccountDashboard() {
  await refreshAccountSession();
  await refreshVault();
  const response = await apiRequest("/api/workspaces");
  const { workspaces } = await response.json();
  element("accountGreeting").textContent = `Bonjour ${accountSession.user.displayName}`;
  element("workspaceCount").textContent = `${workspaces.length} espace${workspaces.length > 1 ? "s" : ""}`;
  element("workspaceList").innerHTML = workspaces.length ? workspaces.map(workspace => {
    const processing = workspace.status === "processing";
    const readOnly = !processing && (workspace.status !== "active" || Date.parse(workspace.expiresAt) <= Date.now());
    return `<button type="button" data-workspace-id="${workspace.id}" class="group grid gap-3 rounded-2xl border border-slate-900/8 p-4 text-left transition hover:border-emerald-700/30 hover:bg-emerald-50/40 sm:grid-cols-[1fr_auto] sm:items-center sm:p-5">
      <span class="min-w-0"><span class="block truncate text-base font-black text-slate-950">${escapeHtml(workspace.title)}</span><span class="mt-1 block text-xs text-slate-500">${escapeHtml(workspace.buyer || "Acheteur non renseigné")} · conservé jusqu'au ${formatDate(workspace.expiresAt)}</span></span>
      <span class="flex items-center gap-3"><span class="rounded-full ${processing ? "bg-blue-100 text-blue-800" : readOnly ? "bg-slate-100 text-slate-600" : "bg-emerald-100 text-emerald-800"} px-2.5 py-1 text-[10px] font-black uppercase">${processing ? "Analyse en cours" : readOnly ? "Lecture seule" : `${workspace.turnsUsed}/${workspace.turnsLimit} échanges`}</span><span class="text-lg text-emerald-700 transition group-hover:translate-x-1">→</span></span>
    </button>`;
  }).join("") : `<div class="rounded-2xl border-2 border-dashed border-slate-900/10 p-8 text-center"><p class="font-black">Aucun dossier enregistré</p><p class="mt-2 text-sm text-slate-500">Utilisez votre crédit disponible pour créer votre premier espace.</p><button type="button" data-new-workspace class="mt-5 rounded-xl bg-slate-950 px-5 py-3 text-sm font-black text-white">Créer mon premier dossier</button></div>`;

  const usage = accountSession.usage;
  element("creditSummary").textContent = `${usage.workspaceCredits} crédit${usage.workspaceCredits > 1 ? "s" : ""} dossier`;
  element("subscriptionSummary").textContent = usage.subscription
    ? `${usage.subscription.label} : ${usage.subscription.used}/${usage.subscription.limit} dossiers utilisés jusqu'au ${formatDate(usage.subscription.periodEnd)}.`
    : "Aucun abonnement actif. Un crédit est consommé uniquement lorsqu'un nouvel espace est créé.";
  element("planButtons").innerHTML = accountSession.plans.map(plan => `<button type="button" data-plan-code="${plan.code}" ${plan.available ? "" : "disabled"} class="w-full rounded-xl border border-slate-900/10 p-3 text-left transition hover:border-emerald-700/30 disabled:cursor-not-allowed disabled:opacity-45"><span class="flex items-center justify-between gap-3"><strong class="text-sm">${escapeHtml(plan.label)}</strong><span class="text-sm font-black">${new Intl.NumberFormat("fr-FR").format(plan.amount)} FCFA${plan.billingMode === "subscription" ? "/mois" : ""}</span></span><span class="mt-1 block text-[11px] leading-4 text-slate-500">${planUsageText(plan)}</span></button>`).join("");
  element("billingPortalButton").classList.toggle("hidden", !accountSession.billingConfigured);
  const paymentState = new URLSearchParams(window.location.search).get("paiement");
  element("billingNote").textContent = paymentState === "confirme"
    ? "Paiement reçu. Le crédit apparaît dès la confirmation sécurisée de Stripe; rechargez si nécessaire."
    : accountSession.billingConfigured
      ? "Le prix et les droits sont vérifiés par le serveur après confirmation du paiement."
      : "Paiement en ligne non activé sur ce pilote. Votre code d'invitation fournit un crédit d'essai unique.";
  showOnly("accountDashboard");
  element("accountHomeButton").classList.remove("hidden");
}

function renderVault() {
  const filesUsed = vaultUsage?.filesUsed || 0;
  element("vaultUsage").textContent = vaultUsage ? `${filesUsed}/${vaultUsage.fileLimit} pièces · ${formatBytes(vaultUsage.bytesUsed)}` : "";
  element("vaultList").innerHTML = vaultDocuments.length ? vaultDocuments.map(document => {
    const expiry = document.expiresOn ? `Expire le ${formatDate(document.expiresOn)}` : "Sans échéance renseignée";
    return `<article class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-900/8 px-3 py-3"><span class="min-w-0"><strong class="block truncate text-sm text-slate-900">${escapeHtml(document.name)}</strong><span class="mt-1 block text-[11px] ${document.expired ? "font-bold text-rose-700" : "text-slate-500"}">${escapeHtml(VAULT_CATEGORY_LABELS[document.category] || "Autre")} · ${escapeHtml(expiry)} · ${formatBytes(document.size)}</span></span><button type="button" data-delete-vault-id="${document.id}" class="rounded-lg border border-slate-900/10 px-2.5 py-1.5 text-[11px] font-bold text-slate-600">Supprimer</button></article>`;
  }).join("") : '<p class="rounded-xl border border-dashed border-slate-900/10 p-4 text-center text-xs text-slate-500">Le coffre est vide. Ajoutez une preuve que vous réutilisez souvent.</p>';
  for (const id of [...selectedVaultIds]) if (!vaultDocuments.some(document => document.id === id)) selectedVaultIds.delete(id);
  element("vaultPicker").classList.toggle("hidden", !accountMode || vaultDocuments.length === 0);
  element("vaultPickerCount").textContent = `${selectedVaultIds.size} sélectionnée${selectedVaultIds.size > 1 ? "s" : ""}`;
  element("vaultPickerList").innerHTML = vaultDocuments.map(document => `<label class="flex cursor-pointer items-start gap-2 rounded-xl border ${selectedVaultIds.has(document.id) ? "border-blue-300/60 bg-blue-300/10" : "border-white/10"} p-3 text-xs"><input type="checkbox" data-vault-id="${document.id}" ${selectedVaultIds.has(document.id) ? "checked" : ""} ${document.expired ? "disabled" : ""} class="mt-0.5 accent-blue-300" /><span class="min-w-0"><strong class="block truncate text-white">${escapeHtml(document.name)}</strong><span class="mt-1 block ${document.expired ? "text-rose-300" : "text-slate-500"}">${escapeHtml(VAULT_CATEGORY_LABELS[document.category] || "Autre")}${document.expired ? " · expirée" : ""}</span></span></label>`).join("");
  updateFileLabels();
}

async function refreshVault() {
  if (!accountMode) return;
  const response = await apiRequest("/api/vault");
  const payload = await response.json();
  vaultDocuments = payload.documents;
  vaultUsage = payload.usage;
  renderVault();
}

async function uploadVaultDocument(event) {
  event.preventDefault();
  const file = element("vaultFile").files[0];
  if (!file) return;
  const button = element("vaultUploadButton");
  button.disabled = true;
  button.textContent = "Enregistrement…";
  try {
    const form = new FormData();
    form.append("document", file, file.name);
    form.append("category", element("vaultCategory").value);
    if (element("vaultExpiresOn").value) form.append("expiresOn", element("vaultExpiresOn").value);
    await apiRequest("/api/vault", { method: "POST", body: form });
    element("vaultFile").value = "";
    element("vaultExpiresOn").value = "";
    await refreshVault();
  } catch (error) {
    window.alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Enregistrer";
  }
}

async function deleteVaultDocument(id) {
  if (!window.confirm("Supprimer cette preuve du coffre ? Les dossiers déjà créés conservent leur copie.")) return;
  await apiRequest(`/api/vault/${id}`, { method: "DELETE" });
  selectedVaultIds.delete(id);
  await refreshVault();
}

async function loadWorkspace(workspaceId, { keepPosition = false } = {}) {
  let response = await apiRequest(`/api/workspaces/${workspaceId}`);
  let payload = await response.json();
  if (!payload.case && payload.job && payload.workspace.status === "processing") {
    element("billingNote").textContent = `${payload.job.status_message || "Analyse sécurisée en cours"} · ${payload.job.progress || 0} %. Vous pouvez laisser cette page ouverte.`;
    showOnly("accountDashboard");
    await waitForAgentJob(payload.job.id, {
      build: true,
      onProgress: job => { element("billingNote").textContent = `${job.status_message || "Analyse sécurisée en cours"} · ${job.progress || 0} %`; }
    });
    response = await apiRequest(`/api/workspaces/${workspaceId}`);
    payload = await response.json();
  }
  activeWorkspace = payload.workspace;
  activeCase = payload.case;
  activeFeedback = payload.feedback || null;
  renderWorkspace();
  showOnly("analysisWorkspace");
  if (!keepPosition) window.scrollTo({ top: 0, behavior: "smooth" });
}

async function openNewWorkspace() {
  await resetCase(false);
  await refreshVault();
  showOnly("caseSetup");
  element("accessCodeField").classList.add("hidden");
  element("privacyNote").textContent = "Espace privé : ce DAO sera lié à votre compte et à un seul crédit. Vous pourrez le reprendre plus tard.";
}

async function submitLogin(event) {
  event.preventDefault();
  setAccountError("");
  try {
    await apiRequest("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: element("loginEmail").value, password: element("loginPassword").value })
    });
    element("loginPassword").value = "";
    await renderAccountDashboard();
  } catch (error) {
    setAccountError(error.message);
  }
}

async function submitRegister(event) {
  event.preventDefault();
  setAccountError("");
  try {
    await apiRequest("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: element("registerName").value,
        email: element("registerEmail").value,
        password: element("registerPassword").value,
        invitationCode: element("registerInvitation").value
      })
    });
    element("registerPassword").value = "";
    element("registerInvitation").value = "";
    await renderAccountDashboard();
  } catch (error) {
    setAccountError(error.message);
  }
}

async function logoutAccount() {
  try { await apiRequest("/api/auth/logout", { method: "POST" }); } catch { /* clear the local view anyway */ }
  accountSession = null;
  activeWorkspace = null;
  activeCase = null;
  element("accountHomeButton").classList.add("hidden");
  showAuthForm("login");
  showOnly("accountGate");
}

async function startCheckout(planCode) {
  try {
    const response = await apiRequest("/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planCode })
    });
    window.location.assign((await response.json()).url);
  } catch (error) {
    window.alert(error.message);
  }
}

async function openBillingPortal() {
  try {
    const response = await apiRequest("/api/billing/portal", { method: "POST" });
    window.location.assign((await response.json()).url);
  } catch (error) {
    window.alert(error.message);
  }
}

async function initializeAccountMode() {
  try {
    const response = await apiRequest("/api/account/config");
    accountConfig = await response.json();
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
  accountMode = Boolean(accountConfig.enabled);
  if (!accountMode) return false;
  element("modeBadge").textContent = "Compte privé · dossiers enregistrés";
  element("invitationCodeField").classList.toggle("hidden", accountConfig.registration !== "invitation");
  if (accountConfig.registration === "closed") element("showRegister").disabled = true;
  showOnly("accountGate");
  try {
    await renderAccountDashboard();
  } catch (error) {
    if (error.status !== 401) setAccountError(error.message);
    showOnly("accountGate");
  }
  return true;
}

async function initialize() {
  if (!analyzer || !ledgerBuilder || !window.JSZip) {
    setSetupError("Les modules de l'atelier n'ont pas pu être chargés.");
    return;
  }
  if (apiBaseUrl) {
    const accountsReady = await initializeAccountMode().catch(error => {
      setSetupError(`Le service de comptes n'a pas démarré : ${error.message}`);
      return false;
    });
    if (!accountsReady) {
      element("modeBadge").textContent = "Serveur privé · suppression 24 h";
      element("accessCodeField").classList.remove("hidden");
      element("privacyNote").textContent = "Mode serveur privé : fichiers isolés par dossier et supprimés automatiquement après 24 h. Utilisez une adresse HTTPS hors réseau local.";
    }
  }
  element("daoFile").addEventListener("change", event => { selectedDao = event.target.files[0] || null; updateFileLabels(); });
  element("companyFiles").addEventListener("change", event => { selectedDocuments = [...event.target.files]; updateFileLabels(); });
  element("vaultPickerList").addEventListener("change", event => {
    const id = event.target.closest("[data-vault-id]")?.dataset.vaultId;
    if (!id) return;
    if (event.target.checked) selectedVaultIds.add(id); else selectedVaultIds.delete(id);
    renderVault();
  });
  element("caseForm").addEventListener("submit", analyzeCase);
  element("demoButton").addEventListener("click", loadDemo);
  element("chatForm").addEventListener("submit", event => { event.preventDefault(); sendQuestion(element("chatInput").value); });
  element("quickQuestions").addEventListener("click", event => { const question = event.target.closest("[data-question]")?.dataset.question; if (question) sendQuestion(question); });
  element("downloadFinal").addEventListener("click", downloadFinalPackage);
  element("deleteCaseButton").addEventListener("click", async () => {
    if (!window.confirm(accountMode ? "Supprimer définitivement cet espace et ses fichiers ? Le crédit ne sera pas recrédité." : "Supprimer ce dossier ?")) return;
    await resetCase(true);
    if (accountMode) await renderAccountDashboard();
  });
  element("newCaseButton").addEventListener("click", () => accountMode ? openNewWorkspace() : resetCase(false));
  element("showLogin").addEventListener("click", () => showAuthForm("login"));
  element("showRegister").addEventListener("click", () => showAuthForm("register"));
  element("loginForm").addEventListener("submit", submitLogin);
  element("registerForm").addEventListener("submit", submitRegister);
  element("logoutButton").addEventListener("click", logoutAccount);
  element("newWorkspaceButton").addEventListener("click", openNewWorkspace);
  element("vaultForm").addEventListener("submit", uploadVaultDocument);
  element("vaultList").addEventListener("click", event => {
    const id = event.target.closest("[data-delete-vault-id]")?.dataset.deleteVaultId;
    if (id) deleteVaultDocument(id).catch(error => window.alert(error.message));
  });
  element("accountHomeButton").addEventListener("click", () => renderAccountDashboard().catch(error => window.alert(error.message)));
  element("workspaceList").addEventListener("click", event => {
    const workspaceId = event.target.closest("[data-workspace-id]")?.dataset.workspaceId;
    if (workspaceId) loadWorkspace(workspaceId).catch(error => window.alert(error.message));
    if (event.target.closest("[data-new-workspace]")) openNewWorkspace();
  });
  element("planButtons").addEventListener("click", event => {
    const planCode = event.target.closest("[data-plan-code]")?.dataset.planCode;
    if (planCode) startCheckout(planCode);
  });
  element("billingPortalButton").addEventListener("click", openBillingPortal);
  element("pilotFeedbackForm").addEventListener("submit", submitPilotFeedback);
  updateFileLabels();
}

document.addEventListener("DOMContentLoaded", initialize);
