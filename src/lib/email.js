// ⚡ NOUVEAU : envoi d'e-mails transactionnels — utilisé pour (1) le
// formulaire "Suggestion / Remboursement" de l'app (voir routes/contact.js)
// et (2) les rappels "essai/abonnement se termine dans 2 jours" (voir
// lib/subscriptionReminders.js).
//
// Choix : l'API HTTP de Resend (https://resend.com) plutôt qu'un SMTP
// classique — pas de dépendance npm supplémentaire (un simple fetch), et un
// tier gratuit largement suffisant pour démarrer (100 emails/jour).
//
// ⚠️ Étape MANUELLE requise, que je ne peux pas faire à ta place : crée un
// compte sur https://resend.com, vérifie le domaine kaba-app.fr (ajout de
// quelques enregistrements DNS chez ton registrar), récupère une clé API,
// et mets-la dans RESEND_API_KEY (+ RESEND_FROM_EMAIL) dans ton .env. Sans
// domaine vérifié, Resend refuse d'envoyer depuis une adresse @kaba-app.fr.
//
// Tant que RESEND_API_KEY n'est pas configurée, sendEmail() ne plante pas :
// elle journalise l'email dans les logs serveur ("mode simulé") pour que le
// reste de la fonctionnalité (formulaire de contact, etc.) reste testable
// sans compte Resend.

export async function sendEmail({ to, subject, text, replyTo, cc }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || 'Kaba <support@kaba-app.fr>';

  if (!apiKey) {
    console.warn(
      '[email] RESEND_API_KEY manquante — email NON envoyé (mode simulé). Voir lib/email.js pour la config.',
    );
    console.log('[email:simulé]', { to, subject, replyTo, cc, text });
    return { simulated: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
      // ⚡ NOUVEAU : copie à l'expéditeur (voir routes/contact.js) — pour
      // qu'il garde une trace de son propre message, comme un accusé de
      // réception. Resend accepte `cc` en chaîne ou tableau, on tolère les
      // deux ici pour rester simple à appeler.
      ...(cc ? { cc: Array.isArray(cc) ? cc : [cc] } : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Envoi email échoué (${res.status}) ${detail}`);
  }
  return res.json();
}
