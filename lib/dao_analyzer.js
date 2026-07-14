(function initDaoAnalyzer(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubmissionDaoAnalyzer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildDaoAnalyzer() {
  "use strict";

  const REQUIREMENTS = [
    {
      id: "ninea",
      label: "NINEA et registre du commerce",
      criticality: "critical",
      patterns: [/\bninea\b/i, /\brccm\b/i, /registre.{0,20}commerce/i]
    },
    {
      id: "quitus",
      label: "Quitus fiscal et social",
      criticality: "critical",
      patterns: [/quitus.{0,30}(fiscal|social)/i, /attestation.{0,30}(ipres|css)/i, /régularité.{0,30}(fiscale|sociale)/i]
    },
    {
      id: "bank",
      label: "Garantie ou caution de soumission",
      criticality: "critical",
      patterns: [/garantie.{0,40}(soumission|bancaire)/i, /caution.{0,40}(soumission|bancaire)/i]
    },
    {
      id: "submission_form",
      label: "Formulaire ou lettre de soumission",
      criticality: "critical",
      patterns: [/lettre.{0,20}soumission/i, /formulaire.{0,30}(soumission|offre)/i, /acte.{0,20}engagement/i]
    },
    {
      id: "technical",
      label: "Offre technique et méthodologie",
      criticality: "critical",
      patterns: [/offre.{0,20}technique/i, /mémoire.{0,20}technique/i, /méthodologie/i, /plan.{0,20}travail/i]
    },
    {
      id: "financial",
      label: "Offre financière et bordereau de prix",
      criticality: "critical",
      patterns: [/offre.{0,20}financi[eè]re/i, /bordereau.{0,30}prix/i, /\bbpu\b/i, /\bdqe\b/i, /devis.{0,20}quantitatif/i]
    },
    {
      id: "reference",
      label: "Références ou expériences similaires",
      criticality: "review",
      patterns: [/références?.{0,40}similaires?/i, /expériences?.{0,40}similaires?/i, /attestation.{0,30}bonne exécution/i]
    },
    {
      id: "staff",
      label: "Personnel clé, CV et diplômes",
      criticality: "review",
      patterns: [/personnel.{0,20}cl[ée]/i, /curriculum.{0,20}vitae/i, /\bcv\b.{0,40}(signé|personnel|expert)/i, /diplômes?.{0,30}(expert|personnel)/i]
    },
    {
      id: "financial_capacity",
      label: "Capacité financière et états financiers",
      criticality: "review",
      patterns: [/capacité.{0,30}financi[eè]re/i, /états?.{0,30}financiers?/i, /chiffre.{0,20}affaires/i, /ligne.{0,20}crédit/i]
    },
    {
      id: "certification",
      label: "Agréments et certifications",
      criticality: "review",
      patterns: [/agrément.{0,40}(requis|exigé|professionnel)/i, /certificat.{0,30}(iso|conformité|qualité)/i, /certification.{0,30}(requise|exigée)/i]
    },
    {
      id: "site_visit",
      label: "Attestation de visite de site",
      criticality: "review",
      patterns: [/visite.{0,30}(site|lieux)/i, /attestation.{0,30}visite/i]
    },
    {
      id: "power_of_attorney",
      label: "Pouvoir de signature",
      criticality: "review",
      patterns: [/pouvoir.{0,30}(signature|signataire)/i, /procuration/i, /habilitation.{0,30}signer/i]
    }
  ];

  const INJECTION_PATTERNS = [
    /ignore\s+(toutes?\s+)?(les\s+)?instructions/i,
    /ignore\s+(all|previous)\s+instructions/i,
    /system\s+prompt/i,
    /developer\s+message/i,
    /assistant\s*:/i,
    /exfiltrat(e|ion)/i,
    /révèle.{0,30}(secret|instruction|prompt)/i
  ];

  const MONTHS = {
    janvier: 0,
    février: 1,
    fevrier: 1,
    mars: 2,
    avril: 3,
    mai: 4,
    juin: 5,
    juillet: 6,
    août: 7,
    aout: 7,
    septembre: 8,
    octobre: 9,
    novembre: 10,
    décembre: 11,
    decembre: 11
  };

  function normalizeWhitespace(value) {
    return String(value || "")
      .replace(/[\u00a0\u202f]/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }

  function normalizeForMatch(value) {
    return normalizeWhitespace(value).toLocaleLowerCase("fr").replace(/\s+/g, " ");
  }

  function toPages(input) {
    if (Array.isArray(input?.pages) && input.pages.length) {
      return input.pages.map((page, index) => ({
        page: Number(page.page || page.pageNumber || index + 1),
        text: normalizeWhitespace(page.text)
      }));
    }
    return [{ page: 1, text: normalizeWhitespace(input?.text || "") }];
  }

  function excerpt(text, index, length = 240) {
    const flat = normalizeWhitespace(text).replace(/\n+/g, " ");
    const start = Math.max(0, index - Math.floor(length * 0.35));
    const end = Math.min(flat.length, start + length);
    return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
  }

  function evidenceForPatterns(pages, patterns, limit = 3) {
    const found = [];
    for (const page of pages) {
      const flat = normalizeWhitespace(page.text).replace(/\n+/g, " ");
      for (const pattern of patterns) {
        const match = flat.match(pattern);
        if (!match) continue;
        const quote = excerpt(flat, match.index || 0);
        if (!found.some(item => item.page === page.page && item.quote === quote)) {
          found.push({ page: page.page, quote });
        }
        if (found.length >= limit) return found;
      }
    }
    return found;
  }

  function findContext(pages, anchorPatterns, valuePattern) {
    for (const page of pages) {
      const flat = normalizeWhitespace(page.text).replace(/\n+/g, " ");
      for (const anchor of anchorPatterns) {
        const anchorMatch = flat.match(anchor);
        if (!anchorMatch) continue;
        const windowStart = Math.max(0, (anchorMatch.index || 0) - 80);
        const windowText = flat.slice(windowStart, Math.min(flat.length, windowStart + 520));
        const valueMatch = windowText.match(valuePattern);
        if (valueMatch) {
          return {
            value: valueMatch[0],
            groups: valueMatch,
            evidence: { page: page.page, quote: excerpt(flat, windowStart + (valueMatch.index || 0)) }
          };
        }
      }
    }
    return null;
  }

  function parseFrenchDate(raw) {
    const value = normalizeForMatch(raw).replace(/1er/g, "1");
    let match = value.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/);
    if (match) {
      const date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
      return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
    }
    match = value.match(/\b(\d{1,2})\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+(20\d{2})\b/);
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[3]), MONTHS[match[2]], Number(match[1])));
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }

  function extractDeadline(pages) {
    const datePattern = /\b(?:1er|\d{1,2})(?:[\/.-]\d{1,2}[\/.-]20\d{2}|\s+(?:janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+20\d{2})(?:\s+(?:à|a)\s+\d{1,2}(?:\s*h\s*\d{0,2}|:\d{2}))?/i;
    const result = findContext(pages, [/au plus tard/i, /date.{0,20}limite/i, /offres? devront être soumises/i], datePattern);
    if (!result) return { value: null, isoDate: null, evidence: [] };
    return { value: result.value, isoDate: parseFrenchDate(result.value), evidence: [result.evidence] };
  }

  function extractAmount(pages) {
    const result = findContext(
      pages,
      [/garantie.{0,30}soumission/i, /caution.{0,30}soumission/i],
      /\b\d[\d .\u00a0\u202f]{2,}\s*(?:f\s*cfa|fcfa|xof)\b|\b\d+(?:[,.]\d+)?\s*%/i
    );
    return result ? { value: normalizeWhitespace(result.value), evidence: [result.evidence] } : { value: null, evidence: [] };
  }

  function extractValidity(pages) {
    const result = findContext(
      pages,
      [/demeureront valides/i, /validité.{0,20}offres/i, /offres?.{0,25}(?:restera|resteront|reste).{0,20}valide/i],
      /(?:\(\s*)?\d{1,3}(?:\s*\))?\s*jours/i
    );
    if (!result) return { value: null, days: null, evidence: [] };
    const digits = result.value.match(/\d{1,3}/);
    return { value: normalizeWhitespace(result.value), days: digits ? Number(digits[0]) : null, evidence: [result.evidence] };
  }

  function extractSubmissionMode(pages) {
    const patterns = [
      { value: "Dépôt électronique", patterns: [/soumission.{0,40}(électronique|en ligne|plateforme)/i, /dépôt.{0,30}(électronique|plateforme)/i] },
      { value: "Envoi par courriel", patterns: [/offres?.{0,60}@/i, /envoyées?.{0,30}(courriel|email|e-mail)/i] },
      { value: "Dépôt physique", patterns: [/offres? devront être soumises à l'adresse/i, /dépôt.{0,30}(physique|pli fermé|secrétariat)/i, /sous pli ferm[ée]/i, /d[ée]pos[ée]es?.{0,30}secr[ée]tariat/i] }
    ];
    for (const option of patterns) {
      const evidence = evidenceForPatterns(pages, option.patterns, 1);
      if (evidence.length) return { value: option.value, evidence };
    }
    return { value: null, evidence: [] };
  }

  function inferReferenceCount(evidence) {
    for (const item of evidence) {
      const normalized = normalizeForMatch(item.quote);
      const direct = normalized.match(/(?:au moins|min(?:imum)? de?)\s*(\d{1,2})\s*(?:références?|expériences?)/i);
      if (direct) return Math.max(1, Math.min(20, Number(direct[1])));
      const parentheses = normalized.match(/(?:références?|expériences?)[^\d]{0,25}\(?\s*(\d{1,2})\s*\)?/i);
      if (parentheses) return Math.max(1, Math.min(20, Number(parentheses[1])));
    }
    return 1;
  }

  function analyzeDao(input) {
    const pages = toPages(input);
    const requirements = REQUIREMENTS.map(definition => {
      const evidence = evidenceForPatterns(pages, definition.patterns);
      if (!evidence.length) return null;
      return {
        id: definition.id,
        label: definition.label,
        criticality: definition.criticality,
        count: definition.id === "reference" ? inferReferenceCount(evidence) : 1,
        evidence
      };
    }).filter(Boolean);

    const injectionFindings = [];
    for (const page of pages) {
      for (const pattern of INJECTION_PATTERNS) {
        const match = page.text.match(pattern);
        if (!match) continue;
        injectionFindings.push({
          page: page.page,
          quote: excerpt(page.text, match.index || 0),
          warning: "Instruction potentiellement malveillante trouvée dans un document. Elle est traitée comme du contenu, jamais comme une consigne pour l'agent."
        });
      }
    }

    const characterCount = pages.reduce((sum, page) => sum + page.text.length, 0);
    return {
      pages,
      facts: {
        deadline: extractDeadline(pages),
        bidSecurity: extractAmount(pages),
        validity: extractValidity(pages),
        submissionMode: extractSubmissionMode(pages)
      },
      requirements,
      injectionFindings,
      textQuality: characterCount < Math.max(250, pages.length * 80) ? "insufficient" : "readable",
      characterCount
    };
  }

  function quoteExists(pages, pageNumber, quote) {
    const page = toPages({ pages }).find(item => item.page === Number(pageNumber));
    if (!page || !quote) return false;
    const needle = normalizeForMatch(String(quote).replace(/^…|…$/g, ""));
    return needle.length >= 12 && normalizeForMatch(page.text).includes(needle);
  }

  return {
    INJECTION_PATTERNS,
    REQUIREMENTS,
    analyzeDao,
    evidenceForPatterns,
    normalizeForMatch,
    normalizeWhitespace,
    parseFrenchDate,
    quoteExists,
    toPages
  };
});
