(function initLedgerBuilder(root, factory) {
  const api = typeof module !== "undefined" && module.exports
    ? factory(require("./dao_analyzer.js"), require("./document_classifier.js"))
    : factory(root.SubmissionDaoAnalyzer, root.SubmissionClassifier);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubmissionLedger = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildLedgerModule(analyzer, classifier) {
  "use strict";

  const STATUS_LABELS = {
    not_ready: "Non prêt",
    needs_review: "Revue nécessaire",
    ready_for_final_review: "Prêt pour revue finale"
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function documentName(document) {
    return document.relativePath || document.webkitRelativePath || document.name || "Document sans nom";
  }

  function cleanEvidence(pages, evidence) {
    return (evidence || [])
      .filter(item => analyzer.quoteExists(pages, item.page, item.quote))
      .map(item => ({
        page: Number(item.page),
        quote: item.quote,
        ...(item.ocr ? { ocr: true, ocrConfidence: item.ocrConfidence } : {})
      }));
  }

  function factWithValidatedEvidence(pages, fact) {
    if (!fact) return { value: null, evidence: [] };
    const clean = cleanEvidence(pages, fact.evidence);
    const conflicts = (fact.conflicts || []).map(conflict => ({
      ...conflict,
      evidence: cleanEvidence(pages, conflict.evidence)
    })).filter(conflict => conflict.value && conflict.evidence.length);
    const lots = (fact.lots || []).map(lot => ({
      ...lot,
      evidence: cleanEvidence(pages, lot.evidence)
    })).filter(lot => lot.value && lot.evidence.length);
    const superseded = (fact.superseded || []).map(item => ({
      ...item,
      evidence: cleanEvidence(pages, item.evidence)
    })).filter(item => item.value && item.evidence.length);
    return {
      ...fact,
      evidence: clean,
      conflicts,
      lots,
      superseded,
      verified: Boolean(fact.value && clean.length && fact.status !== "conflict")
    };
  }

  function rowAction(requirement, mapped, missingCount) {
    if (missingCount > 0) {
      return `Ajouter ${missingCount} pièce${missingCount > 1 ? "s" : ""} conforme${missingCount > 1 ? "s" : ""} pour « ${requirement.label} », puis vérifier date, signature et format.`;
    }
    const warnings = mapped.flatMap(item => item.warnings || []);
    if (warnings.length) return `Relire les fichiers associés : ${warnings.join(" ")}`;
    return "Comparer le contenu, la validité et les signatures à l'exigence citée avant dépôt.";
  }

  function buildRows(analysis, classified) {
    return analysis.requirements.map(requirement => {
      const expected = Math.max(1, Number(requirement.count) || 1);
      const mapped = classified.mapped.filter(item => item.type === requirement.id);
      const matched = Math.min(expected, mapped.length);
      const missingCount = Math.max(0, expected - matched);
      const warnings = mapped.flatMap(item => item.warnings || []);
      const evidence = cleanEvidence(analysis.pages, requirement.evidence);
      const status = missingCount > 0 ? "missing" : warnings.length ? "needs_review" : "found";
      return {
        id: requirement.id,
        label: requirement.label,
        criticality: requirement.criticality,
        expected,
        matched,
        status,
        evidence,
        documents: mapped.map(item => ({
          name: documentName(item.file),
          output: item.output,
          warnings: item.warnings || []
        })),
        action: rowAction(requirement, mapped, missingCount),
        confidence: evidence.length && matched === expected ? "high" : evidence.length || matched ? "medium" : "low"
      };
    });
  }

  function overallStatus(rows) {
    if (rows.some(row => row.status === "missing")) return "not_ready";
    if (rows.some(row => row.status === "needs_review")) return "needs_review";
    return "ready_for_final_review";
  }

  function buildLedger({ dao, documents = [], title = "Dossier de soumission", buyer = "", generatedAt = nowIso() }) {
    if (!analyzer || !classifier) throw new Error("Les modules d'analyse ne sont pas chargés.");
    const analysis = dao?.requirements && dao?.pages ? dao : analyzer.analyzeDao(dao || {});
    const requirements = analysis.requirements.map(item => ({ ...item, type: item.id }));
    const classified = classifier.classifyDocuments({ documents, requirements });
    const rows = buildRows(analysis, classified);
    const expected = rows.reduce((sum, row) => sum + row.expected, 0);
    const matched = rows.reduce((sum, row) => sum + row.matched, 0);
    const status = overallStatus(rows);
    const facts = {
      deadline: factWithValidatedEvidence(analysis.pages, analysis.facts.deadline),
      bidSecurity: factWithValidatedEvidence(analysis.pages, analysis.facts.bidSecurity),
      validity: factWithValidatedEvidence(analysis.pages, analysis.facts.validity),
      submissionMode: factWithValidatedEvidence(analysis.pages, analysis.facts.submissionMode)
    };
    const ocrPages = analysis.pages.filter(page => page.ocr);
    const lowConfidenceOcrPages = ocrPages.filter(page => Number.isFinite(page.ocrConfidence) && page.ocrConfidence < 75);

    return {
      schemaVersion: "1.0",
      generatedAt,
      case: { title, buyer },
      status,
      statusLabel: STATUS_LABELS[status],
      coverage: {
        expected,
        matched,
        missing: Math.max(0, expected - matched),
        percent: expected ? Math.round((matched / expected) * 100) : 0
      },
      facts,
      rows,
      unclassified: classified.unclassified.map(documentName),
      security: {
        promptInjectionDetected: analysis.injectionFindings.length > 0,
        findings: analysis.injectionFindings
      },
      extraction: {
        textQuality: analysis.textQuality,
        characterCount: analysis.characterCount,
        pageCount: analysis.pages.length,
        requirementCount: rows.length,
        ocrPageCount: ocrPages.length,
        lowConfidenceOcrPageCount: lowConfidenceOcrPages.length,
        procurementReferences: analysis.scope?.references || [],
        multipleProcurementsSuspected: Boolean(analysis.scope?.multipleProcurementsSuspected)
      },
      warnings: [
        ...(analysis.scope?.multipleProcurementsSuspected ? ["Plusieurs références d'appel d'offres distinctes ont été détectées. Séparez les DAO avant une analyse payante."] : []),
        ...(analysis.textQuality === "insufficient" ? ["Le texte du DAO est insuffisant. Un PDF scanné peut nécessiter un OCR ou une lecture visuelle."] : []),
        ...(rows.length === 0 ? ["Aucune exigence n'a été extraite automatiquement. Ne considérez pas le dossier comme contrôlé."] : []),
        ...(ocrPages.length ? [`OCR utilisé sur ${ocrPages.length} page(s) : chaque citation OCR doit être comparée à l'image source.`] : []),
        ...(lowConfidenceOcrPages.length ? [`Confiance OCR faible sur ${lowConfidenceOcrPages.length} page(s). Une lecture humaine est obligatoire.`] : []),
        ...Object.entries(facts).filter(([, fact]) => fact.status === "conflict").map(([name]) => `Plusieurs valeurs incompatibles ont été détectées pour « ${name} ». Une validation humaine est obligatoire.`),
        "Le registre assiste la revue documentaire; le DAO original et la validation humaine prévalent."
      ],
      methodology: "Chaque exigence doit avoir une citation retrouvée dans le DAO et une pièce correspondante. Une citation non retrouvée est supprimée."
    };
  }

  function evidenceSuffix(evidence) {
    if (!evidence?.length) return "";
    const pages = evidence.map(item => item.page).join(", ");
    const ocr = evidence.filter(item => item.ocr && Number.isFinite(item.ocrConfidence));
    return ` (DAO p. ${pages}${ocr.length ? `, OCR ${Math.min(...ocr.map(item => item.ocrConfidence))} %` : ""})`;
  }

  function answerQuestion(ledger, rawQuestion) {
    const question = analyzer.normalizeForMatch(rawQuestion);
    const missing = ledger.rows.filter(row => row.status === "missing");
    const review = ledger.rows.filter(row => row.status === "needs_review");
    if (!question) return {
      role: "assistant",
      content: "Posez une question sur une exigence, une page, une pièce manquante ou la prochaine action.",
      generatedAt: nowIso(),
      mode: "local-evidence"
    };

    const conflictText = (label, fact) => {
      const options = [fact, ...(fact.conflicts || [])]
        .filter(option => option.value && option.evidence?.length)
        .map(option => `« ${option.value} »${evidenceSuffix(option.evidence)}`);
      return `${label} non confirmé : plusieurs valeurs incompatibles ont été trouvées (${options.join(" ; ")}). Faites valider la clause source avant toute action.`;
    };
    const deadlineAnswer = () => {
      const fact = ledger.facts.deadline;
      if (fact.status === "conflict") return conflictText("Date limite", fact);
      return fact.verified
        ? `La date limite détectée est « ${fact.value} »${evidenceSuffix(fact.evidence)}. Confirmez-la sur l'avis officiel avant tout dépôt.`
        : "Je n'ai pas trouvé de date limite suffisamment traçable. Vérifiez l'avis officiel et les instructions de soumission.";
    };
    const guaranteeAnswer = () => {
      const fact = ledger.facts.bidSecurity;
      const row = ledger.rows.find(item => item.id === "bank");
      if (fact.status === "conflict") return conflictText("Garantie", fact);
      const lotDetails = fact.lots?.length ? ` ${fact.lots.map(lot => `${lot.lot} : ${lot.value}${evidenceSuffix(lot.evidence)}`).join(" ; ")}.` : "";
      return fact.verified
        ? `La garantie détectée est « ${fact.value} »${evidenceSuffix(fact.evidence)}.${lotDetails} ${row ? row.action : "Vérifiez sa forme et sa validité dans le DAO."}`
        : "Aucun montant de garantie n'a été extrait avec une citation vérifiable. Recherchez les sections « garantie » ou « caution de soumission ».";
    };
    const submissionAnswer = () => {
      const fact = ledger.facts.submissionMode;
      if (fact.status === "conflict") return conflictText("Canal de dépôt", fact);
      return fact.verified
        ? `Le mode détecté est « ${fact.value} »${evidenceSuffix(fact.evidence)}. Relisez l'adresse, le nombre de copies et les règles d'enveloppe.`
        : "Le canal de dépôt n'est pas établi par une citation vérifiée. Contrôlez les données particulières du DAO.";
    };
    const missingAnswer = () => missing.length
      ? `Le dossier a ${ledger.coverage.missing} pièce${ledger.coverage.missing > 1 ? "s" : ""} manquante${ledger.coverage.missing > 1 ? "s" : ""} : ${missing.map(row => `${row.label}${evidenceSuffix(row.evidence)}`).join(" ; ")}.`
      : "Aucune catégorie extraite n'est sans pièce, mais cela ne valide pas le contenu. Poursuivez avec la revue des dates, signatures et formats.";
    const requestedPriorityCount = () => {
      const direct = question.match(/\b([1-9])\b.{0,30}(?:pi[eè]ces?|priorit|actions?)/);
      if (direct) return Number(direct[1]);
      const words = { une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5 };
      const word = question.match(/\b(une|deux|trois|quatre|cinq)\b.{0,30}(?:pi[eè]ces?|priorit|actions?)/);
      return word ? words[word[1]] : 5;
    };
    const priorityAnswer = () => {
      const actions = [...missing, ...review, ...ledger.rows.filter(row => row.status === "found")].slice(0, requestedPriorityCount());
      return actions.length
        ? `Priorités : ${actions.map((row, index) => `${index + 1}. ${row.action}${evidenceSuffix(row.evidence)}`).join(" ")}`
        : "Commencez par une lecture humaine du DAO : aucune exigence fiable n'a été extraite.";
    };

    const intents = [];
    if (/date|d[eé]lai|quand|heure/.test(question)) intents.push(["Date limite", deadlineAnswer]);
    if (/garantie|caution|montant/.test(question)) intents.push(["Garantie", guaranteeAnswer]);
    if (/mode|d[eé]p[oô]t|adresse|soumettre|courriel|plateforme/.test(question)) intents.push(["Dépôt", submissionAnswer]);
    if (/manqu|blocage|non pr[eê]t|reste/.test(question)) intents.push(["Pièces manquantes", missingAnswer]);
    if (/priorit|prochaine|action|faire maintenant|plan|préparer en premier|pi[eè]ces? à préparer/.test(question)) intents.push(["Priorités", priorityAnswer]);
    if (/injection|instruction malveillante|prompt|s[eé]curit/.test(question)) intents.push(["Sécurité", () => ledger.security.promptInjectionDetected
      ? `${ledger.security.findings.length} instruction suspecte a été isolée. Elle est traitée comme du texte du document et n'a jamais autorité sur l'analyse.`
      : "Aucune instruction suspecte n'a été détectée par les motifs de sécurité locaux."]);
    if (/statut|pr[eê]t|r[eé]sum[eé]|situation/.test(question)) intents.push(["Statut", () => `Statut : ${ledger.statusLabel}. Couverture documentaire : ${ledger.coverage.matched}/${ledger.coverage.expected} (${ledger.coverage.percent} %). ${missing.length ? `${missing.length} exigence${missing.length > 1 ? "s" : ""} reste${missing.length > 1 ? "nt" : ""} bloquante${missing.length > 1 ? "s" : ""}.` : "Aucune pièce manquante parmi les exigences extraites."}`]);

    let answer;
    if (intents.length) {
      answer = intents.length === 1
        ? intents[0][1]()
        : intents.map(([label, build]) => `${label} — ${build()}`).join("\n\n");
    } else {
      const matchedRow = ledger.rows.find(row => question.includes(analyzer.normalizeForMatch(row.label).split(" ")[0]) || question.includes(row.id));
      answer = matchedRow
        ? `${matchedRow.label} : ${matchedRow.status === "missing" ? "pièce manquante" : matchedRow.status === "needs_review" ? "pièce trouvée, revue requise" : "pièce trouvée"}${evidenceSuffix(matchedRow.evidence)}. ${matchedRow.action}`
        : "Je ne peux répondre qu'à partir du registre vérifié. Demandez par exemple : « Qu'est-ce qui manque ? », « Quelle est la date limite ? » ou « Quelle est la prochaine action ? ».";
    }

    return {
      role: "assistant",
      content: answer,
      generatedAt: nowIso(),
      mode: "local-evidence"
    };
  }

  function toMarkdown(ledger) {
    const lines = [
      `# Registre de conformité — ${ledger.case.title}`,
      "",
      `- Statut : **${ledger.statusLabel}**`,
      `- Couverture : **${ledger.coverage.matched}/${ledger.coverage.expected} (${ledger.coverage.percent} %)**`,
      `- Acheteur : ${ledger.case.buyer || "Non renseigné"}`,
      `- Généré le : ${ledger.generatedAt}`,
      "",
      "## Faits clés",
      "",
      `- Date limite : ${ledger.facts.deadline.value || "Non détectée"}${evidenceSuffix(ledger.facts.deadline.evidence)}`,
      `- Garantie : ${ledger.facts.bidSecurity.value || "Non détectée"}${evidenceSuffix(ledger.facts.bidSecurity.evidence)}`,
      `- Validité : ${ledger.facts.validity.value || "Non détectée"}${evidenceSuffix(ledger.facts.validity.evidence)}`,
      `- Dépôt : ${ledger.facts.submissionMode.value || "Non détecté"}${evidenceSuffix(ledger.facts.submissionMode.evidence)}`,
      "",
      "## Exigences et pièces",
      ""
    ];

    for (const row of ledger.rows) {
      const marker = row.status === "missing" ? "[ ]" : "[x]";
      lines.push(`### ${marker} ${row.label}`);
      lines.push("");
      lines.push(`- État : ${row.status}`);
      lines.push(`- Pièces : ${row.documents.length ? row.documents.map(item => item.name).join(", ") : "Aucune"}`);
      lines.push(`- Source DAO : ${row.evidence.length ? row.evidence.map(item => `p. ${item.page} — « ${item.quote} »`).join(" ; ") : "Citation non disponible"}`);
      lines.push(`- Action : ${row.action}`);
      lines.push("");
    }

    lines.push("## Avertissements", "", ...ledger.warnings.map(warning => `- ${warning}`), "");
    if (ledger.security.promptInjectionDetected) {
      lines.push("## Sécurité documentaire", "", `- ${ledger.security.findings.length} instruction suspecte isolée et ignorée.`, "");
    }
    return lines.join("\n");
  }

  function actionPlanMarkdown(ledger) {
    const ordered = [
      ...ledger.rows.filter(row => row.status === "missing"),
      ...ledger.rows.filter(row => row.status === "needs_review"),
      ...ledger.rows.filter(row => row.status === "found")
    ];
    return [
      `# Plan d'actions — ${ledger.case.title}`,
      "",
      `Statut de départ : **${ledger.statusLabel}**`,
      "",
      ...ordered.map((row, index) => `${index + 1}. [ ] **${row.label}** — ${row.action}${evidenceSuffix(row.evidence)}`),
      "",
      "## Contrôles finaux obligatoires",
      "",
      "- [ ] Confirmer la date et l'heure sur la source officielle",
      "- [ ] Vérifier signatures, cachets, validité et nombre de copies",
      "- [ ] Contrôler l'ordre, le format et le canal de dépôt",
      "- [ ] Faire valider le dossier final par une personne responsable",
      ""
    ].join("\n");
  }

  return {
    STATUS_LABELS,
    actionPlanMarkdown,
    answerQuestion,
    buildLedger,
    cleanEvidence,
    toMarkdown
  };
});
