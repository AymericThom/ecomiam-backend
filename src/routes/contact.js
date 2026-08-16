import { Router } from 'express';
import { sendEmail } from '../lib/email.js';

export const contactRouter = Router();

// ⚡ NOUVEAU : formulaire "Suggestion / Remboursement" de l'onglet
// Paramètres (voir ContactSheet dans AppUI.js) — envoie un email au support,
// avec l'adresse de l'utilisateur en "reply-to" pour pouvoir lui répondre
// directement depuis la boîte mail, sans repasser par l'app.
const VALID_TYPES = new Set(['refund', 'suggestion', 'bug', 'other']);
const TYPE_LABELS = {
  refund: 'Remboursement',
  suggestion: 'Suggestion',
  bug: 'Bug',
  other: 'Autre',
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

contactRouter.post('/', async (req, res) => {
  try {
    const { type, message, replyToEmail } = req.body || {};

    if (!VALID_TYPES.has(type)) {
      return res.status(400).json({ error: 'Type de message invalide.' });
    }
    const cleanMessage = String(message || '').trim();
    if (cleanMessage.length < 5) {
      return res
        .status(400)
        .json({ error: 'Le message est trop court pour être envoyé.' });
    }
    if (cleanMessage.length > 4000) {
      return res.status(400).json({ error: 'Le message est trop long (4000 caractères max).' });
    }
    if (replyToEmail && !EMAIL_REGEX.test(replyToEmail)) {
      return res.status(400).json({ error: 'Adresse email invalide.' });
    }

    const supportInbox = process.env.SUPPORT_INBOX_EMAIL || 'support@kaba-app.fr';
    await sendEmail({
      to: supportInbox,
      subject: `[Kaba · ${TYPE_LABELS[type]}] Nouveau message depuis l'app`,
      text: [
        `Type : ${TYPE_LABELS[type]}`,
        `Utilisateur (id) : ${req.user?.id || 'inconnu'}`,
        `Email de réponse : ${replyToEmail || 'non fourni — impossible de répondre directement'}`,
        '',
        cleanMessage,
      ].join('\n'),
      replyTo: replyToEmail || undefined,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[contact]', err);
    res.status(500).json({ error: 'Envoi impossible pour le moment, réessaie plus tard.' });
  }
});
