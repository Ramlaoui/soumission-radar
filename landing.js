(function initializeLanding() {
  const config = window.SoumissionRadarConfig || {};
  const subject = encodeURIComponent("Candidature pilote — Soumission Radar");
  const body = encodeURIComponent("Bonjour,\n\nJe souhaite faire contrôler un dossier de soumission.\n\nSecteur :\nDate limite :\nNombre de pièces :\n\nMerci.");
  const href = config.checkoutUrl || `mailto:${config.contactEmail}?subject=${subject}&body=${body}`;
  document.querySelectorAll("[data-contact-link]").forEach(link => { link.href = href; });
})();
