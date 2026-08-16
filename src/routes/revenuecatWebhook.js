import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

// ⚠️ MIGRATION SQL REQUISE (à exécuter une fois dans Supabase > SQL Editor)
// avant que les 3 nouvelles colonnes ci-dessous fonctionnent :
//
//   ALTER TABLE profiles
//     ADD COLUMN IF NOT EXISTS subscription_expires_at timestamptz,
//     ADD COLUMN IF NOT EXISTS is_trial boolean DEFAULT false,
//     ADD COLUMN IF NOT EXISTS reminder_2d_sent_at timestamptz;
//
// Sans cette migration, les appels .update() ci-dessous échoueront
// silencieusement pour ces champs (Supabase ignore les colonnes inconnues
// par défaut) — is_pro continuera de fonctionner normalement dans tous les cas.

export const revenuecatWebhookRouter = Router();

// RevenueCat > Project Settings > Integrations > Webhooks
// URL à configurer : https://TON-BACKEND.com/api/webhooks/revenuecat
// Authorization header à configurer côté RevenueCat : "Bearer <REVENUECAT_WEBHOOK_SECRET>"
// Doc officielle : https://www.revenuecat.com/docs/integrations/webhooks
//
// ⚠️ Piège classique corrigé ici : CANCELLATION ne veut PAS dire "l'accès est
// terminé" — ça veut dire "le renouvellement auto est coupé", l'utilisateur
// garde l'accès jusqu'à la fin de la période déjà payée. Le code précédent
// coupait le PRO immédiatement sur CANCELLATION, ce qui aurait viré des
// utilisateurs qui avaient encore des jours payés devant eux — exactement le
// genre de bug qui génère des demandes de remboursement/1-star reviews au
// lancement. Même chose pour BILLING_ISSUE : la doc RevenueCat est explicite,
// "ça ne veut pas dire que l'abonnement a expiré" (période de grâce prévue
// par Apple/Google). Le SEUL événement qui doit couper l'accès est
// EXPIRATION — c'est celui qui arrive une fois que la période payée (ou la
// période de grâce) est vraiment terminée.
const ACTIVE_EVENTS = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION']);
const INACTIVE_EVENTS = new Set(['EXPIRATION']);
// Purement informatifs : on les journalise mais on NE touche PAS à is_pro.
// PRODUCT_CHANGE est volontairement exclu de ACTIVE_EVENTS : la doc
// RevenueCat elle-même prévient qu'un changement de plan ne garantit pas
// qu'un paiement a été pris — se fier uniquement à
// INITIAL_PURCHASE/RENEWAL/EXPIRATION pour l'entitlement.
const INFORMATIONAL_EVENTS = new Set(['CANCELLATION', 'BILLING_ISSUE', 'PRODUCT_CHANGE', 'SUBSCRIPTION_PAUSED']);

revenuecatWebhookRouter.post('/', async (req, res) => {
  const auth = req.headers.authorization || '';
  const expected = `Bearer ${process.env.REVENUECAT_WEBHOOK_SECRET}`;
  if (!process.env.REVENUECAT_WEBHOOK_SECRET || auth !== expected) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    const event = req.body?.event;
    if (!event) return res.status(400).json({ error: 'Payload invalide' });

    // app_user_id = l'identifiant que le mobile a passé à RevenueCat.
    // On recommande d'y mettre l'UUID Supabase de l'utilisateur (voir docs/SETUP.md).
    const userId = event.app_user_id;
    const type = event.type;

    // ⚡ NOUVEAU : on garde la date de fin d'entitlement + si c'est encore
    // la période d'essai — utilisé par lib/subscriptionReminders.js pour
    // savoir à qui envoyer le rappel email "2 jours avant" (voir aussi les
    // rappels notification côté mobile, scheduleTrialEndReminders /
    // scheduleRenewalReminder dans notifications.js, qui couvrent le même
    // besoin mais uniquement pendant que l'app est/a été ouverte récemment
    // — le rappel email couvre aussi le cas où l'app n'est pas relancée).
    const expiresAt = event.expiration_at_ms
      ? new Date(event.expiration_at_ms).toISOString()
      : null;
    const isTrial = event.period_type === 'TRIAL' || event.period_type === 'INTRO';

    if (supabaseAdmin && userId) {
      if (ACTIVE_EVENTS.has(type)) {
        await supabaseAdmin
          .from('profiles')
          .update({
            is_pro: true,
            subscription_expires_at: expiresAt,
            is_trial: isTrial,
            // Nouveau cycle (achat/renouvellement) → on réautorise l'envoi
            // du rappel "2 jours avant" pour CETTE échéance-là.
            reminder_2d_sent_at: null,
          })
          .eq('id', userId);
      } else if (INACTIVE_EVENTS.has(type)) {
        await supabaseAdmin
          .from('profiles')
          .update({
            is_pro: false,
            subscription_expires_at: null,
            is_trial: false,
          })
          .eq('id', userId);
      } else if (type === 'TRANSFER') {
        // Un transfert déplace l'entitlement vers ce app_user_id — on lui
        // accorde le PRO ici. On ne peut pas révoquer le compte source à
        // partir de ce seul payload (RevenueCat ne l'envoie pas), donc si tu
        // constates des comptes PRO orphelins après transfert, c'est là qu'il
        // faut creuser en premier.
        await supabaseAdmin
          .from('profiles')
          .update({ is_pro: true, subscription_expires_at: expiresAt, is_trial: isTrial })
          .eq('id', userId);
      } else if (!INFORMATIONAL_EVENTS.has(type)) {
        console.warn(`[webhooks/revenuecat] type d'événement non géré : ${type}`);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[webhooks/revenuecat]', err);
    res.status(500).json({ error: 'Erreur webhook' });
  }
});
