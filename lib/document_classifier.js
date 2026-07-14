(function initDocumentClassifier(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.SubmissionClassifier = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildDocumentClassifier() {
  "use strict";

  const DOC_RULES = {
    ninea: {
      label: "NINEA/RCCM",
      folder: "01_ADMIN",
      outputName: "NINEA_RCCM",
      patterns: [/ninea/i, /rccm/i, /registre.*commerce/i]
    },
    quitus: {
      label: "Quitus fiscal et social",
      folder: "01_ADMIN",
      outputName: "QUITUS_FISCAL_SOCIAL",
      patterns: [/quitus/i, /attestation.*(?:fiscale|sociale)/i, /régularité.*(?:fiscale|sociale)/i, /ipres/i, /\bcss\b/i]
    },
    bank: {
      label: "Garantie/caution bancaire",
      folder: "01_ADMIN",
      outputName: "GARANTIE_BANCAIRE",
      patterns: [/garantie/i, /caution/i, /banque/i, /bancaire/i]
    },
    submission_form: {
      label: "Lettre ou formulaire de soumission",
      folder: "01_ADMIN",
      outputName: "LETTRE_SOUMISSION",
      patterns: [/lettre.*soumission/i, /formulaire.*(?:soumission|offre)/i, /acte.*engagement/i]
    },
    technical: {
      label: "Mémoire technique",
      folder: "03_TECHNIQUE",
      outputName: "MEMOIRE_TECHNIQUE",
      patterns: [/memoire/i, /mémoire/i, /technique/i, /methodologie/i, /méthodologie/i, /planning/i]
    },
    financial: {
      label: "Bordereau de prix / offre financière",
      folder: "04_FINANCIER",
      outputName: "BORDEREAU_PRIX",
      patterns: [/prix/i, /financier/i, /financiere/i, /financière/i, /devis/i, /bordereau/i]
    },
    reference: {
      label: "Référence similaire",
      folder: "02_REFERENCES",
      outputName: "REFERENCE",
      patterns: [/reference/i, /référence/i, /client/i, /attestation/i, /bonne.*execution/i, /contrat.*similaire/i]
    },
    staff: {
      label: "Personnel clé, CV et diplômes",
      folder: "03_TECHNIQUE/PERSONNEL",
      outputName: "PERSONNEL_CLE",
      patterns: [/personnel.*cl[ée]/i, /\bcv\b/i, /curriculum.*vitae/i, /dipl[oô]me/i, /expert/i]
    },
    financial_capacity: {
      label: "Capacité et états financiers",
      folder: "01_ADMIN/FINANCES",
      outputName: "CAPACITE_FINANCIERE",
      patterns: [/capacit[ée].*financi/i, /[ée]tats?.*financiers?/i, /chiffre.*affaires/i, /ligne.*cr[ée]dit/i, /bilan/i]
    },
    certification: {
      label: "Agrément ou certification",
      folder: "01_ADMIN/AGREMENTS",
      outputName: "AGREMENT_CERTIFICATION",
      patterns: [/agr[ée]ment/i, /certificat/i, /certification/i, /\biso[- ]?\d*/i]
    },
    site_visit: {
      label: "Attestation de visite de site",
      folder: "03_TECHNIQUE",
      outputName: "ATTESTATION_VISITE_SITE",
      patterns: [/attestation.*visite/i, /visite.*(?:site|lieux)/i]
    },
    power_of_attorney: {
      label: "Pouvoir de signature",
      folder: "01_ADMIN",
      outputName: "POUVOIR_SIGNATURE",
      patterns: [/pouvoir.*(?:signature|signataire)/i, /procuration/i, /habilitation.*signer/i]
    }
  };

  function searchableText(file) {
    return `${file.name || ""}\n${file.relativePath || file.webkitRelativePath || ""}\n${file.text || file._text || ""}`;
  }

  function scoreFileForRule(file, rule) {
    const haystack = searchableText(file);
    return rule.patterns.reduce((score, pattern) => score + (pattern.test(haystack) ? 1 : 0), 0);
  }

  function findBestFile(files, rule, usedFiles) {
    return files
      .filter(file => !usedFiles.has(file))
      .map(file => ({ file, score: scoreFileForRule(file, rule) }))
      .filter(candidate => candidate.score > 0)
      .sort((a, b) => b.score - a.score || (a.file.name || "").localeCompare(b.file.name || ""))[0]?.file || null;
  }

  function findReferenceFiles(files, count, usedFiles) {
    return files
      .filter(file => !usedFiles.has(file))
      .map(file => ({ file, score: scoreFileForRule(file, DOC_RULES.reference) }))
      .filter(candidate => candidate.score > 0)
      .sort((a, b) => b.score - a.score || (a.file.name || "").localeCompare(b.file.name || ""))
      .slice(0, count)
      .map(candidate => candidate.file);
  }

  function detectFileWarnings(file) {
    const haystack = searchableText(file).toLowerCase();
    const warnings = [];

    if (/brouillon|draft|provisoire|a relire|à relire/.test(haystack)) {
      warnings.push("Le fichier ressemble à un brouillon et doit être relu par un humain.");
    }
    if (/old|ancienne|ancien|obsolete|obsolète|expire|expiré/.test(haystack)) {
      warnings.push("Le fichier semble ancien ou obsolète.");
    }
    if (/photo|whatsapp|image/i.test(file.name || "") && !/attestation|reference|référence|contrat/i.test(haystack)) {
      warnings.push("Le nom du fichier ressemble à une pièce jointe non structurée.");
    }

    return warnings;
  }

  function extensionFor(file) {
    const name = file.name || "";
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot) : "";
  }

  function outputFor(rule, index) {
    const suffix = index == null ? "" : `_${String(index + 1).padStart(2, "0")}`;
    return `${rule.folder}/${rule.outputName}${suffix}`;
  }

  function evaluatePackageQuality({ mapped, missing }) {
    const warnings = mapped.flatMap(item => (item.warnings || []).map(warning => ({
      label: item.label,
      output: item.output,
      warning
    })));
    const blockers = missing.map(item => ({
      label: item.label,
      output: item.output,
      blocker: "Pièce obligatoire manquante."
    }));
    const status = blockers.length > 0
      ? "not_ready"
      : warnings.length > 0
        ? "needs_human_review"
        : "ready_for_review";

    return {
      status,
      blockers,
      warnings,
      mappedCount: mapped.length,
      missingCount: missing.length
    };
  }

  function classifyDocuments({ documents, requirements }) {
    const usedFiles = new Set();
    const mapped = [];
    const missing = [];

    for (const requirement of requirements) {
      const requirementType = requirement.type || requirement.id;
      const rule = DOC_RULES[requirementType];
      if (!rule) continue;

      if (requirementType === "reference") {
        const count = Math.max(1, Number(requirement.count) || 1);
        const references = findReferenceFiles(documents, count, usedFiles);
        references.forEach((file, index) => {
          usedFiles.add(file);
          mapped.push({
            type: "reference",
            label: `${rule.label} ${index + 1}`,
            source: file.relativePath || file.webkitRelativePath || file.name,
            output: `${outputFor(rule, index)}${extensionFor(file)}`,
            warnings: detectFileWarnings(file),
            requirement,
            file
          });
        });
        for (let index = references.length; index < count; index += 1) {
          missing.push({
            type: "reference",
            label: `${rule.label} ${index + 1}`,
            output: `${rule.folder}/_PIECE_MANQUANTE_${rule.outputName}_${String(index + 1).padStart(2, "0")}.md`,
            requirement
          });
        }
        continue;
      }

      const file = findBestFile(documents, rule, usedFiles);
      if (file) {
        usedFiles.add(file);
        mapped.push({
          type: requirementType,
          label: rule.label,
          source: file.relativePath || file.webkitRelativePath || file.name,
          output: `${outputFor(rule)}${extensionFor(file)}`,
          warnings: detectFileWarnings(file),
          requirement,
          file
        });
      } else {
        missing.push({
          type: requirementType,
          label: rule.label,
          output: `${rule.folder}/_PIECE_MANQUANTE_${rule.outputName}.md`,
          requirement
        });
      }
    }

    const unclassified = documents.filter(file => !usedFiles.has(file));
    return {
      mapped,
      missing,
      unclassified,
      quality: evaluatePackageQuality({ mapped, missing })
    };
  }

  return {
    DOC_RULES,
    classifyDocuments,
    detectFileWarnings,
    evaluatePackageQuality,
    findBestFile,
    findReferenceFiles,
    scoreFileForRule
  };
});
