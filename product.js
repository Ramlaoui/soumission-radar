(function initProduct() {
  "use strict";

  const config = window.SoumissionRadarConfig || {};
  const classifier = window.SubmissionClassifier;
  const MAX_FILES = 50;
  const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
  const TEXT_EXTENSIONS = new Set(["txt", "md", "csv", "json", "xml"]);
  let files = [];
  let lastAudit = null;

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
    return String(value || "dossier-soumission")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 70) || "dossier-soumission";
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} Ko`;
    return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
  }

  function configureContactLinks() {
    const subject = encodeURIComponent("Candidature pilote — Soumission Radar");
    const body = encodeURIComponent("Bonjour,\n\nJe souhaite faire contrôler un dossier de soumission.\n\nSecteur :\nDate limite :\nNombre de pièces :\n\nMerci.");
    const href = config.checkoutUrl || `mailto:${config.contactEmail}?subject=${subject}&body=${body}`;
    document.querySelectorAll("[data-contact-link]").forEach(link => {
      link.href = href;
    });
  }

  async function descriptorFor(file) {
    const extension = file.name.split(".").pop()?.toLowerCase() || "";
    let text = "";
    if (TEXT_EXTENSIONS.has(extension)) {
      text = await file.slice(0, 12000).text();
    }
    return {
      name: file.name,
      relativePath: file.webkitRelativePath || file.name,
      size: file.size,
      text,
      browserFile: file
    };
  }

  function requirementsFromForm() {
    const requirements = [...document.querySelectorAll('input[name="requirement"]:checked')]
      .map(input => ({ type: input.value, count: 1 }));
    const referenceCount = Math.max(0, Math.min(20, Number(element("requiredReferences").value) || 0));
    if (referenceCount > 0) requirements.push({ type: "reference", count: referenceCount });
    return requirements;
  }

  function deadlineState() {
    const raw = element("deadline").value;
    if (!raw) return null;
    const deadline = new Date(`${raw}T23:59:59`);
    const days = Math.ceil((deadline.getTime() - Date.now()) / 86400000);
    return { raw, days, expired: days < 0 };
  }

  function setError(message) {
    const error = element("formError");
    error.textContent = message;
    error.classList.toggle("hidden", !message);
  }

  function setFiles(nextFiles) {
    const unique = new Map();
    for (const file of nextFiles) unique.set(`${file.name}:${file.size}:${file.lastModified}`, file);
    files = [...unique.values()];
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (files.length > MAX_FILES) {
      files = [];
      setError(`Limite dépassée : ${MAX_FILES} fichiers maximum.`);
    } else if (total > MAX_TOTAL_BYTES) {
      files = [];
      setError("Limite dépassée : 250 Mo maximum pour cette version locale.");
    } else {
      setError("");
    }
    element("fileSummary").textContent = files.length
      ? `${files.length} fichier${files.length > 1 ? "s" : ""} — ${formatBytes(files.reduce((sum, file) => sum + file.size, 0))}`
      : "Aucun fichier sélectionné.";
  }

  function statusPresentation(audit) {
    if (audit.deadline?.expired) {
      return {
        title: "Délai dépassé",
        badge: "BLOQUÉ",
        badgeClass: "bg-rose-400/15 text-rose-200",
        descriptionClass: "border-rose-300/20 bg-rose-300/5 text-rose-100",
        description: "La date limite saisie est dépassée. Vérifiez immédiatement l'avis officiel et les éventuels reports."
      };
    }
    if (audit.quality.status === "not_ready") {
      return {
        title: "Dossier non prêt",
        badge: "BLOCAGES",
        badgeClass: "bg-rose-400/15 text-rose-200",
        descriptionClass: "border-rose-300/20 bg-rose-300/5 text-rose-100",
        description: "Des catégories obligatoires n'ont aucun fichier correspondant. Ne déposez pas avant de les résoudre."
      };
    }
    if (audit.quality.status === "needs_human_review") {
      return {
        title: "Revue humaine requise",
        badge: "À RELIRE",
        badgeClass: "bg-amber-300/15 text-amber-200",
        descriptionClass: "border-amber-300/20 bg-amber-300/5 text-amber-100",
        description: "Toutes les catégories sont présentes, mais certains fichiers semblent anciens, provisoires ou mal nommés."
      };
    }
    return {
      title: "Prêt pour revue finale",
      badge: "À VÉRIFIER",
      badgeClass: "bg-emerald-300/15 text-emerald-200",
      descriptionClass: "border-emerald-300/20 bg-emerald-300/5 text-emerald-100",
      description: "Chaque catégorie sélectionnée a un fichier correspondant. Vérifiez maintenant le contenu, les dates, signatures et formats avec le DAO."
    };
  }

  function renderAudit(audit) {
    const status = statusPresentation(audit);
    element("emptyResults").classList.add("hidden");
    element("auditResults").classList.remove("hidden");
    element("statusTitle").textContent = status.title;
    element("statusBadge").textContent = status.badge;
    element("statusBadge").className = `rounded-full px-3 py-1 text-xs font-bold ${status.badgeClass}`;
    element("statusDescription").textContent = status.description;
    element("statusDescription").className = `rounded-2xl border p-4 text-sm leading-6 ${status.descriptionClass}`;
    element("mappedCount").textContent = audit.mapped.length;
    element("missingCount").textContent = audit.missing.length;
    element("warningCount").textContent = audit.quality.warnings.length;

    element("mappedList").innerHTML = audit.mapped.length
      ? audit.mapped.map(item => `<li class="rounded-xl bg-white/5 p-3"><span class="font-semibold text-white">${escapeHtml(item.label)}</span><span class="mt-1 block break-all text-slate-400">${escapeHtml(item.source)} → ${escapeHtml(item.output)}</span></li>`).join("")
      : '<li class="text-slate-500">Aucune pièce classée.</li>';

    const issues = [
      ...audit.missing.map(item => ({ kind: "Manquante", label: item.label, detail: "Pièce obligatoire absente." })),
      ...audit.quality.warnings.map(item => ({ kind: "Alerte", label: item.label, detail: item.warning }))
    ];
    element("issueList").innerHTML = issues.length
      ? issues.map(issue => `<li class="rounded-xl bg-rose-300/5 p-3 text-rose-100"><span class="font-bold">${escapeHtml(issue.kind)} — ${escapeHtml(issue.label)}</span><span class="mt-1 block text-rose-100/70">${escapeHtml(issue.detail)}</span></li>`).join("")
      : '<li class="text-slate-500">Aucun blocage lexical détecté.</li>';

    element("unclassifiedList").innerHTML = audit.unclassified.length
      ? audit.unclassified.map(file => `<li class="break-all">${escapeHtml(file.relativePath || file.name)}</li>`).join("")
      : '<li>Aucun fichier non classé.</li>';
  }

  async function analyze(event) {
    event?.preventDefault();
    if (!classifier || !window.JSZip) {
      setError("Le module de contrôle n'a pas pu être chargé. Rechargez la page.");
      return;
    }
    if (!files.length) {
      setError("Ajoutez au moins un fichier ou chargez l'exemple.");
      return;
    }

    setError("");
    const button = element("analyzeButton");
    button.disabled = true;
    button.textContent = "Analyse en cours…";
    try {
      const requirements = requirementsFromForm();
      if (!requirements.length) {
        setError("Sélectionnez au moins une exigence du DAO.");
        return;
      }
      const documents = await Promise.all(files.map(descriptorFor));
      const classified = classifier.classifyDocuments({ documents, requirements });
      lastAudit = {
        ...classified,
        title: element("tenderTitle").value.trim(),
        buyer: element("buyer").value.trim(),
        deadline: deadlineState(),
        generatedAt: new Date().toISOString()
      };
      renderAudit(lastAudit);
      element("results").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      setError(`Analyse impossible : ${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = "Analyser le dossier";
    }
  }

  function checklistFor(audit) {
    return [
      `# Checklist de soumission — ${audit.title}`,
      "",
      `Acheteur : ${audit.buyer || "Non renseigné"}`,
      `Date limite : ${audit.deadline?.raw || "Non renseignée"}`,
      `Généré le : ${audit.generatedAt}`,
      "",
      "## Documents classés",
      ...(audit.mapped.length ? audit.mapped.map(item => `- [x] ${item.label} : ${item.output}${item.warnings.length ? ` — ALERTE: ${item.warnings.join("; ")}` : ""}`) : ["- Aucun"]),
      "",
      "## Pièces manquantes",
      ...(audit.missing.length ? audit.missing.map(item => `- [ ] ${item.label}`) : ["- Aucune catégorie manquante détectée"]),
      "",
      "## Contrôles finaux obligatoires",
      "- [ ] Comparer chaque pièce au DAO original",
      "- [ ] Vérifier dates de validité, signatures et cachets",
      "- [ ] Vérifier formats, nombre de copies et canal de dépôt",
      "- [ ] Confirmer la date et l'heure limite sur la source officielle",
      "",
      "Soumission Radar aide à préparer une revue documentaire. Il ne garantit ni la recevabilité ni l'attribution du marché."
    ].join("\n");
  }

  function manifestFor(audit) {
    return {
      genereLe: audit.generatedAt,
      appelOffres: { objet: audit.title, acheteur: audit.buyer, dateLimite: audit.deadline?.raw || null },
      statut: audit.deadline?.expired ? "delai_depasse" : audit.quality.status,
      documentsClasses: audit.mapped.map(({ type, label, source, output, warnings }) => ({ type, libelle: label, source, sortie: output, alertes: warnings })),
      piecesManquantes: audit.missing.map(({ type, label, output }) => ({ type, libelle: label, sortie: output })),
      fichiersNonClasses: audit.unclassified.map(file => file.relativePath || file.name),
      avertissement: "Toujours relire le DAO original avant le dépôt."
    };
  }

  async function downloadZip() {
    if (!lastAudit) return;
    const button = element("downloadZip");
    button.disabled = true;
    button.textContent = "Création du ZIP…";
    try {
      const zip = new window.JSZip();
      for (const item of lastAudit.mapped) {
        zip.file(item.output, item.file.browserFile);
      }
      for (const item of lastAudit.missing) {
        zip.file(item.output, `# Pièce manquante : ${item.label}\n\nAjoutez et vérifiez cette pièce avant tout dépôt.\n`);
      }
      for (const file of lastAudit.unclassified) {
        zip.file(`99_NON_CLASSES/${file.name}`, file.browserFile);
      }
      zip.file("00_CHECKLIST_SOUMISSION.md", `${checklistFor(lastAudit)}\n`);
      zip.file("MANIFESTE_SOUMISSION.json", `${JSON.stringify(manifestFor(lastAudit), null, 2)}\n`);
      zip.file("05_CONTROLES/LISEZ_MOI.md", "# Revue finale obligatoire\n\nCe dossier est un classement automatique. Vérifiez le DAO, le contenu, la validité, les signatures, les formats et le canal de dépôt. Aucun statut ne garantit la recevabilité ou l'attribution.\n");
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `soumission-${slugify(lastAudit.title)}.zip`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError(`ZIP impossible : ${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = "Télécharger le dossier ZIP";
    }
  }

  function loadDemo() {
    const now = Date.now();
    setFiles([
      new File(["NINEA et RCCM de Baobab Solutions"], "scan_entreprise_ninea_rccm.pdf", { type: "application/pdf", lastModified: now }),
      new File(["Quitus fiscal et social valide"], "quitus_fiscal_social_juillet_2026.txt", { type: "text/plain", lastModified: now }),
      new File(["Garantie bancaire"], "garantie_bancaire.pdf", { type: "application/pdf", lastModified: now }),
      new File(["Mémoire technique ancienne version à relire"], "memoire_technique_old_version.txt", { type: "text/plain", lastModified: now }),
      new File(["Bordereau de prix brouillon"], "prix_brouillon_v3.txt", { type: "text/plain", lastModified: now }),
      new File(["Référence client mairie"], "reference_mairie_reseau.pdf", { type: "application/pdf", lastModified: now }),
      new File(["Référence client hôpital"], "reference_hopital_wifi.pdf", { type: "application/pdf", lastModified: now }),
      new File(["Référence client école"], "reference_ecole_support.pdf", { type: "application/pdf", lastModified: now })
    ]);
    analyze();
  }

  function initDropZone() {
    const input = element("documentFiles");
    const dropZone = element("dropZone");
    element("chooseFiles").addEventListener("click", () => input.click());
    input.addEventListener("change", () => setFiles([...input.files]));
    for (const eventName of ["dragenter", "dragover"]) {
      dropZone.addEventListener(eventName, event => {
        event.preventDefault();
        dropZone.classList.add("border-emerald-300", "bg-emerald-300/5");
      });
    }
    for (const eventName of ["dragleave", "drop"]) {
      dropZone.addEventListener(eventName, event => {
        event.preventDefault();
        dropZone.classList.remove("border-emerald-300", "bg-emerald-300/5");
      });
    }
    dropZone.addEventListener("drop", event => setFiles([...event.dataTransfer.files]));
  }

  document.addEventListener("DOMContentLoaded", () => {
    configureContactLinks();
    initDropZone();
    element("auditForm").addEventListener("submit", analyze);
    element("demoButton").addEventListener("click", loadDemo);
    element("downloadZip").addEventListener("click", downloadZip);
  });
})();
