import { Router } from 'express';
import express from 'express';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

export const riscEventsRouter = Router();

// Clés publiques de Google, utilisées pour vérifier la signature des jetons
// d'événements de sécurité — mises en cache et rafraîchies automatiquement
// par `jose` (pas besoin de les re-télécharger à chaque requête).
const GOOGLE_RISC_JWKS = createRemoteJWKSet(
  new URL('https://www.gstatic.com/security/riscconfig/oidc/jwks')
);

// Les identifiants des différents types d'événements que Google peut nous
// envoyer (voir https://developers.google.com/identity/protocols/risc#supported_event_types).
const EVENT_TYPES = {
  SESSIONS_REVOKED: 'https://schemas.openid.net/secevent/risc/event-type/sessions-revoked',
  TOKENS_REVOKED: 'https://schemas.openid.net/secevent/risc/event-type/tokens-revoked',
  ACCOUNT_DISABLED: 'https://schemas.openid.net/secevent/risc/event-type/account-disabled',
  ACCOUNT_ENABLED: 'https://schemas.openid.net/secevent/risc/event-type/account-enabled',
  ACCOUNT_PURGED: 'https://schemas.openid.net/secevent/risc/event-type/account-purged',
  ACCOUNT_CREDENTIAL_CHANGE_REQUIRED: 'https://schemas.openid.net/secevent/risc/event-type/account-credential-change-required',
  VERIFICATION: 'https://schemas.openid.net/secevent/risc/event-type/verification',
};

// Cherche l'utilisateur Supabase correspondant à un "sub" Google (l'identifiant
// stable de son compte Google — PAS son email, qui peut changer). C'est ce
// qu'a stocké Supabase dans identities[].identity_data.sub lors du premier
// signInWithIdToken côté app.
//
// ⚠️ Recherche linéaire volontairement simple pour démarrer : listUsers()
// paginé + recherche en mémoire. Si la base dépasse quelques milliers de
// comptes et que ça devient lent, la vraie solution est d'ajouter une
// colonne `google_sub` indexée sur `profiles`, remplie au moment du sign-in,
// pour transformer cette recherche en un simple `select`.
async function findSupabaseUserByGoogleSub(sub) {
  if (!supabaseAdmin) return null;
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const match = data.users.find((u) =>
      u.identities?.some((i) => i.provider === 'google' && i.identity_data?.sub === sub)
    );
    if (match) return match;
    if (data.users.length < perPage) return null; // dernière page atteinte
    page += 1;
  }
}

// Déconnecte de force toutes les sessions actives d'un utilisateur — utilisé
// pour sessions-revoked, tokens-revoked, account-disabled et
// account-credential-change-required : dans tous ces cas, la bonne réaction
// est "cet utilisateur doit se reconnecter", pas de le bannir définitivement.
async function forceSignOutEverywhere(userId) {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin.auth.admin.signOut(userId, 'global');
  if (error) console.error('[risc] échec de la déconnexion forcée', userId, error.message);
}

async function handleEvent(eventType, eventPayload, subject) {
  const sub = subject?.sub;
  if (!sub) {
    console.warn('[risc] événement reçu sans "sub" exploitable, ignoré', eventType);
    return;
  }

  const user = await findSupabaseUserByGoogleSub(sub);
  if (!user) {
    // Normal si l'événement concerne un compte Google qui ne s'est jamais
    // connecté à Kaba, ou plus vraisemblablement en environnement de test.
    console.log('[risc] aucun utilisateur Kaba correspondant au sub', sub);
    return;
  }

  switch (eventType) {
    case EVENT_TYPES.SESSIONS_REVOKED:
    case EVENT_TYPES.TOKENS_REVOKED:
    case EVENT_TYPES.ACCOUNT_CREDENTIAL_CHANGE_REQUIRED:
      // Google a coupé les sessions/jetons de ce compte (mot de passe changé,
      // déconnexion globale demandée par l'utilisateur...) — on fait pareil
      // de notre côté : l'utilisateur devra se reconnecter avec Google.
      console.log('[risc] déconnexion forcée suite à', eventType, user.id);
      await forceSignOutEverywhere(user.id);
      break;

    case EVENT_TYPES.ACCOUNT_DISABLED: {
      // Compte Google piraté ou suspendu par Google — on coupe l'accès à
      // Kaba immédiatement, plutôt que de laisser un attaquant utiliser une
      // session déjà ouverte dans l'app.
      const reason = eventPayload?.reason; // ex: "hijacking"
      console.log('[risc] compte Google désactivé (', reason, ') — coupure de session', user.id);
      await forceSignOutEverywhere(user.id);
      break;
    }

    case EVENT_TYPES.ACCOUNT_ENABLED:
      // Le compte Google a été réactivé — rien à faire côté Kaba, la
      // prochaine connexion Google fonctionnera normalement.
      console.log('[risc] compte Google réactivé', user.id);
      break;

    case EVENT_TYPES.ACCOUNT_PURGED:
      // L'utilisateur a supprimé son compte Google. On ne supprime PAS son
      // compte Kaba automatiquement (ça reste sa décision, à faire depuis
      // "Supprimer mon compte" dans l'app) — on se contente de couper la
      // session pour éviter qu'elle reste active indéfiniment.
      console.log('[risc] compte Google supprimé, coupure de session Kaba', user.id);
      await forceSignOutEverywhere(user.id);
      break;

    case EVENT_TYPES.VERIFICATION:
      // Événement de test envoyé par Google (ou par toi, via l'API RISC)
      // pour vérifier que l'endpoint répond correctement — rien à faire.
      console.log('[risc] événement de vérification reçu avec succès');
      break;

    default:
      console.log('[risc] type d\'événement non géré, ignoré :', eventType);
  }
}

// Google envoie le jeton en Content-Type: application/secevent+jwt — on lit
// le corps brut nous-mêmes plutôt que de compter sur express.json() (qui ne
// le parserait pas, ce Content-Type n'étant pas du JSON classique).
riscEventsRouter.post('/', express.text({ type: '*/*' }), async (req, res) => {
  try {
    const token = typeof req.body === 'string' ? req.body.trim() : '';
    if (!token) return res.status(400).json({ error: 'corps de requête vide' });

    // Vérifie la signature (clé publique Google), l'émetteur et le
    // destinataire prévu (notre propre Client ID — sans ça, n'importe qui
    // pourrait nous envoyer un jeton signé pour UN AUTRE service Google et
    // se faire passer pour un événement légitime).
    const { payload } = await jwtVerify(token, GOOGLE_RISC_JWKS, {
      issuer: 'https://accounts.google.com',
      audience: process.env.GOOGLE_WEB_CLIENT_ID,
    });

    // Répondre vite : Google attend un 202 rapide, tout traitement métier
    // peut continuer après (mais ici c'est rapide, pas besoin de file
    // d'attente séparée pour l'instant).
    res.status(202).end();

    const events = payload.events || {};
    for (const [eventType, eventPayload] of Object.entries(events)) {
      await handleEvent(eventType, eventPayload, payload.subject);
    }
  } catch (e) {
    console.error('[risc] jeton invalide ou rejeté', e.message);
    if (!res.headersSent) res.status(400).json({ error: 'jeton invalide' });
  }
});
