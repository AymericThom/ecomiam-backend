import { supabaseAdmin } from './supabaseAdmin.js';
import { sendEmail } from './email.js';

// ⚡ NOUVEAU : rappel EMAIL "ton essai/abonnement se termine dans 2 jours",
// en complément du rappel NOTIFICATION déjà envoyé côté mobile (voir
// scheduleTrialEndReminders / scheduleRenewalReminder dans
// mobile/src/notifications/notifications.js). L'email a l'avantage de
// toucher l'utilisateur même s'il n'a pas rouvert l'app récemment (les
// notifications programmées sur l'appareil ne se reprogramment qu'à
// l'ouverture de l'app) et même s'il a désactivé les notifications push.
//
// Ce backend est un process Express classique, toujours démarré (pas de
// serverless ici) — un simple setInterval suffit donc comme "cron" léger,
// pas besoin d'infra externe (Vercel Cron, etc.).
//
// Prérequis : la migration SQL décrite en haut de routes/revenuecatWebhook.js
// (colonnes subscription_expires_at / is_trial / reminder_2d_sent_at), et
// une clé RESEND_API_KEY configurée (voir lib/email.js) pour un envoi réel.

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // toutes les heures
const REMINDER_WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // "2 jours avant"

async function checkAndSendExpiryReminders() {
  if (!supabaseAdmin) return; // pas de Supabase configuré → rien à faire

  const now = Date.now();
  const windowEnd = new Date(now + REMINDER_WINDOW_MS).toISOString();
  const nowIso = new Date(now).toISOString();

  // Profils dont l'abonnement/essai expire dans la fenêtre des 2 prochains
  // jours, PRO actif, et pour qui on n'a pas déjà envoyé le rappel pour
  // CETTE échéance (reminder_2d_sent_at est remis à null à chaque nouveau
  // cycle par le webhook RevenueCat, voir routes/revenuecatWebhook.js).
  const { data: profiles, error } = await supabaseAdmin
    .from('profiles')
    .select('id, is_trial, subscription_expires_at')
    .eq('is_pro', true)
    .is('reminder_2d_sent_at', null)
    .not('subscription_expires_at', 'is', null)
    .gte('subscription_expires_at', nowIso)
    .lte('subscription_expires_at', windowEnd);

  if (error) {
    console.error('[subscriptionReminders] lecture profils échouée', error);
    return;
  }
  if (!profiles?.length) return;

  for (const profile of profiles) {
    try {
      // L'email n'est pas stocké dans `profiles` (voir schéma existant) —
      // on le récupère via l'API admin Supabase Auth à partir de l'UUID.
      const { data: userData, error: userErr } =
        await supabaseAdmin.auth.admin.getUserById(profile.id);
      const email = userData?.user?.email;
      if (userErr || !email) continue; // pas d'email connu (device anonyme) → pas d'email possible

      const label = profile.is_trial
        ? "ton essai gratuit Kaba se termine dans 2 jours"
        : 'ton abonnement Kaba PRO se renouvelle dans 2 jours';
      const cancelHint = profile.is_trial
        ? "Si tu ne veux pas continuer, annule avant la fin de l'essai depuis les réglages de ton compte App Store / Google Play — aucun prélèvement ne sera fait."
        : 'Si tu veux annuler, rends-toi dans les réglages de ton compte App Store / Google Play avant cette date.';

      await sendEmail({
        to: email,
        subject: `⏳ ${label[0].toUpperCase()}${label.slice(1)}`,
        text: `Bonjour,\n\n${label[0].toUpperCase()}${label.slice(1)}.\n\n${cancelHint}\n\nSinon, rien à faire : tout continue normalement.\n\nL'équipe Kaba`,
      });

      await supabaseAdmin
        .from('profiles')
        .update({ reminder_2d_sent_at: new Date().toISOString() })
        .eq('id', profile.id);
    } catch (err) {
      // Un échec isolé (email invalide, Resend indisponible...) ne doit
      // jamais bloquer l'envoi des rappels aux autres utilisateurs.
      console.error('[subscriptionReminders] envoi échoué pour', profile.id, err);
    }
  }
}

export function startSubscriptionReminderJob() {
  if (!supabaseAdmin) {
    console.warn(
      '[subscriptionReminders] Supabase non configuré — rappels email essai/abonnement désactivés.',
    );
    return;
  }
  // Un premier passage peu après le démarrage (pas immédiatement, pour ne
  // pas ralentir le boot du serveur), puis toutes les heures.
  setTimeout(() => checkAndSendExpiryReminders().catch(() => {}), 30_000);
  setInterval(() => checkAndSendExpiryReminders().catch(() => {}), CHECK_INTERVAL_MS);
}
