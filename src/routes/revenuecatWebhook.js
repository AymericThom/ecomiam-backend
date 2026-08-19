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

// ⚠️ MIGRATION SQL SUPPLÉMENTAIRE REQUISE pour le plan famille (voir plus
// bas) :
//
//   ALTER TABLE profiles
//     ADD COLUMN IF NOT EXISTS pro_source text DEFAULT 'own';
//     -- 'own' = a payé son propre abonnement (ou n'est pas PRO)
//     -- 'family' = reçoit le PRO via le plan famille d'un autre membre
//
// Identifiant du produit RevenueCat correspondant au plan "Famille" (celui
// à 59,99€ affiché dans le paywall) — DOIT correspondre exactement à
// l'identifiant configuré dans RevenueCat > Products.
const FAMILY_PRODUCT_ID = process.env.REVENUECAT_FAMILY_PRODUCT_ID || 'kaba_family_annual';

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
            pro_source: 'own', // toujours "own" pour l'acheteur, même sur le plan famille
            subscription_expires_at: expiresAt,
            is_trial: isTrial,
            // Nouveau cycle (achat/renouvellement) → on réautorise l'envoi
            // du rappel "2 jours avant" pour CETTE échéance-là.
            reminder_2d_sent_at: null,
          })
          .eq('id', userId);

        // ⚡ NOUVEAU : le plan famille n'accordait le PRO qu'à l'acheteur —
        // les autres membres de son groupe famille ne recevaient jamais
        // rien, alors que c'est tout l'intérêt du plan. On propage
        // maintenant le PRO à tout le groupe quand le produit acheté est
        // bien le plan famille.
        const isFamilyProduct = event.product_id === FAMILY_PRODUCT_ID;
        if (isFamilyProduct) {
          const { data: buyer } = await supabaseAdmin
            .from('profiles')
            .select('family_group_id')
            .eq('id', userId)
            .single();
          if (buyer?.family_group_id) {
            // On ne touche PAS aux membres qui ont déjà leur propre
            // abonnement ('own') — pas question de leur faire perdre leur
            // date d'expiration à eux au profit de celle du plan famille.
            await supabaseAdmin
              .from('profiles')
              .update({
                is_pro: true,
                pro_source: 'family',
                subscription_expires_at: expiresAt,
                is_trial: isTrial,
                reminder_2d_sent_at: null,
              })
              .eq('family_group_id', buyer.family_group_id)
              .neq('id', userId)
              .neq('pro_source', 'own');
          }
        }
      } else if (INACTIVE_EVENTS.has(type)) {
        await supabaseAdmin
          .from('profiles')
          .update({
            is_pro: false,
            pro_source: 'own',
            subscription_expires_at: null,
            is_trial: false,
          })
          .eq('id', userId);

        // ⚡ NOUVEAU : symétrique de l'octroi ci-dessus — si l'abonnement
        // famille qui expire est celui qui avait été partagé, on retire le
        // PRO aux membres qui l'avaient reçu PAR ce biais (jamais à ceux
        // qui ont leur propre abonnement, `pro_source` les protège déjà).
        const { data: buyer } = await supabaseAdmin
          .from('profiles')
          .select('family_group_id')
          .eq('id', userId)
          .single();
        if (buyer?.family_group_id) {
          await supabaseAdmin
            .from('profiles')
            .update({ is_pro: false, pro_source: 'own', subscription_expires_at: null, is_trial: false })
            .eq('family_group_id', buyer.family_group_id)
            .eq('pro_source', 'family');
        }
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
