import { supabaseAdmin } from './supabaseAdmin.js';
import { sendEmail } from './email.js';
import { sendPushToUser } from './pushNotifications.js';
import { grantPromotionalDays } from './revenuecatAdmin.js';

// ⚡ NOUVEAU : trois jobs de fond, sur le même modèle "setInterval" léger que
// lib/subscriptionReminders.js (ce process Express tourne en continu, pas
// besoin d'infra cron externe). Prérequis : la migration SQL décrite dans
// docs/REFERRAL_RETENTION_SETUP.md.
//
// ⚠️ IMPORTANT : `current_streak` / `longest_streak` NE sont PAS gérés ici —
// ce sont les colonnes déjà écrites directement par le mobile à chaque plat
// cuisiné (voir registerCookedMeal dans mobile/src/screens/AppContent.js).
// C'est volontaire et même préférable : ça veut dire que la récompense de
// parrainage se déclenche sur une vraie preuve d'usage (le filleul a
// vraiment cuisiné 2 jours de suite), pas sur un simple "a rouvert l'app".
// `last_active_date`, lui, EST nouveau et mis à jour par ce même bloc côté
// mobile (même `.update()`, un champ en plus) — voir docs/REFERRAL_RETENTION_SETUP.md
// section "Mobile" pour le diff exact à appliquer.

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // toutes les heures
// Paliers de filleuls CONFIRMÉS (pas juste inscrits) → bonus PRO cumulés
// pour le parrain. Volontairement croissant : plus tu ramènes de gens qui
// restent, plus le prochain palier est généreux, pour donner une raison de
// continuer à inviter au-delà du premier ami.
// 🐛 CORRIGÉ (nouvelle demande) : 4 paliers désormais — 1 / 3 / 5 / 10
// filleuls confirmés (avant : 3 / 5 / 10, donc rien avant le 3e ami). Jours
// de bonus par palier pas précisés par la demande : gardés en progression
// douce (15 / 30 / 60 / 180) en cohérence avec les valeurs déjà en place
// pour 5 et 10.
// 🐛 CORRIGÉ (nouvelle demande) : suppression de la récompense fixe de 14j
// versée à CHAQUE filleul confirmé, en plus des paliers — elle rendait le
// premier ami déjà très rentable et n'incitait pas à en inviter plusieurs.
// Seuls les paliers ci-dessous récompensent désormais le parrain.
const MILESTONE_BONUS_DAYS = { 1: 15, 3: 30, 5: 60, 10: 180 };

// --- 1. Récompense DIFFÉRÉE du parrain -------------------------------------
// Un filleul qui atteint current_streak >= 2 (= revenu un 2e jour de suite,
// pas juste installé l'app) déclenche la récompense de son parrain. Ce
// délai est volontaire : il aligne l'incitation du parrain sur la vraie
// rétention de son filleul plutôt que sur le simple nombre d'inscriptions,
// ce qui limite aussi les abus (comptes fantômes créés juste pour le code).
async function checkReferralConfirmations() {
  if (!supabaseAdmin) return;

  const { data: confirmedReferrals, error } = await supabaseAdmin
    .from('profiles')
    .select('id, referred_by')
    .not('referred_by', 'is', null)
    .is('referral_reward_sent_at', null)
    .gte('current_streak', 2);

  if (error) {
    console.error('[retentionJobs] lecture parrainages confirmés échouée', error);
    return;
  }
  if (!confirmedReferrals?.length) return;

  for (const referred of confirmedReferrals) {
    try {
      const { data: referrer } = await supabaseAdmin
        .from('profiles')
        .select('referral_confirmed_count')
        .eq('id', referred.referred_by)
        .single();
      const newCount = (referrer?.referral_confirmed_count || 0) + 1;

      await supabaseAdmin.from('profiles').update({ referral_confirmed_count: newCount }).eq('id', referred.referred_by);
      // Marqué sur le FILLEUL, pas le parrain : ce flag dit "ce filleul-là a
      // déjà généré la récompense de son parrain", donc il ne peut pas la
      // déclencher deux fois même s'il repasse par ce job plus tard.
      await supabaseAdmin.from('profiles').update({ referral_reward_sent_at: new Date().toISOString() }).eq('id', referred.id);

      if (MILESTONE_BONUS_DAYS[newCount]) {
        await grantPromotionalDays(referred.referred_by, MILESTONE_BONUS_DAYS[newCount]);
        await sendPushToUser(supabaseAdmin, referred.referred_by, {
          title: '🎉 Palier de parrainage débloqué !',
          body: `${newCount} amis fidèles grâce à toi — ${MILESTONE_BONUS_DAYS[newCount]} jours PRO offerts en bonus.`,
        });
      } else {
        // 🐛 CORRIGÉ (nouvelle demande) : plus de récompense hors palier —
        // ce filleul confirmé compte pour le prochain palier, mais on ne
        // notifie plus d'un cadeau immédiat ; le push encourage plutôt à
        // continuer vers le palier suivant.
        const nextMilestone = [1, 3, 5, 10].find((m) => m > newCount);
        await sendPushToUser(supabaseAdmin, referred.referred_by, {
          title: '🎉 Ton ami est resté !',
          body: nextMilestone
            ? `${newCount} amis fidèles grâce à toi. Encore ${nextMilestone - newCount} pour débloquer ton prochain bonus PRO.`
            : `${newCount} amis fidèles grâce à toi !`,
        });
      }
    } catch (err) {
      // Un échec isolé (RevenueCat down, entitlement mal configuré...) ne
      // doit jamais bloquer le traitement des autres parrainages.
      console.error('[retentionJobs] confirmation parrainage échouée pour', referred.id, err);
    }
  }
}

// --- 2. Relance "ta série va se casser" ------------------------------------
// Utilisateurs avec une série d'au moins 3 jours dont la dernière activité
// était HIER (pas aujourd'hui) → s'ils ne reviennent pas aujourd'hui, ils
// perdent leur série. C'est un des leviers de rétention les plus efficaces
// des apps à streak (Duolingo etc.) : la perte imminente motive bien plus
// que le gain.
async function checkStreakAtRisk() {
  if (!supabaseAdmin) return;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data: atRisk, error } = await supabaseAdmin
    .from('profiles')
    .select('id, current_streak')
    .gte('current_streak', 3)
    .eq('last_active_date', yesterday)
    .neq('streak_risk_notified_date', today); // pas déjà relancé aujourd'hui pour cette échéance

  if (error) {
    console.error('[retentionJobs] lecture streaks à risque échouée', error);
    return;
  }
  if (!atRisk?.length) return;

  for (const profile of atRisk) {
    try {
      await sendPushToUser(supabaseAdmin, profile.id, {
        title: `🔥 Ta série de ${profile.current_streak} jours va se casser !`,
        body: "Ouvre l'app aujourd'hui pour la garder vivante.",
      });
      await supabaseAdmin.from('profiles').update({ streak_risk_notified_date: today }).eq('id', profile.id);
    } catch (err) {
      console.error('[retentionJobs] relance streak échouée pour', profile.id, err);
    }
  }
}

// --- 3. Relance inactivité (3 jours puis 7 jours) --------------------------
// Contrairement au rappel streak (ciblé, urgent), celui-ci vise les
// utilisateurs déjà partis — email PLUTÔT que push, car il touche aussi
// ceux qui ont désactivé les notifications ou n'ont pas rouvert l'app
// depuis longtemps (un push programmé sur l'appareil ne se reprogramme
// qu'à l'ouverture de l'app, voir lib/subscriptionReminders.js).
async function checkInactiveUsers() {
  if (!supabaseAdmin) return;
  const now = Date.now();

  for (const [thresholdDays, column, subject, text] of [
    [
      3,
      'inactive_3d_notified_at',
      "On te garde de bonnes recettes au chaud 👀",
      "Ça fait 3 jours qu'on ne t'a pas vu·e sur Kaba. Tes recettes de la semaine t'attendent toujours !",
    ],
    [
      7,
      'inactive_7d_notified_at',
      "On a pensé à toi",
      "Une semaine sans Kaba ! Reviens jeter un œil, on a pensé à quelques recettes qui devraient te plaire.",
    ],
  ]) {
    const cutoffDate = new Date(now - thresholdDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: inactive, error } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .lte('last_active_date', cutoffDate)
      .is(column, null);

    if (error) {
      console.error(`[retentionJobs] lecture inactifs (${thresholdDays}j) échouée`, error);
      continue;
    }
    if (!inactive?.length) continue;

    for (const profile of inactive) {
      try {
        const { data: userData } = await supabaseAdmin.auth.admin.getUserById(profile.id);
        const email = userData?.user?.email;
        if (email) {
          await sendEmail({ to: email, subject, text: `Bonjour,\n\n${text}\n\nL'équipe Kaba` });
        }
        await supabaseAdmin.from('profiles').update({ [column]: new Date().toISOString() }).eq('id', profile.id);
      } catch (err) {
        console.error(`[retentionJobs] relance inactivité (${thresholdDays}j) échouée pour`, profile.id, err);
      }
    }
  }
}

async function runAllRetentionJobs() {
  await checkReferralConfirmations().catch((err) => console.error('[retentionJobs] checkReferralConfirmations', err));
  await checkStreakAtRisk().catch((err) => console.error('[retentionJobs] checkStreakAtRisk', err));
  await checkInactiveUsers().catch((err) => console.error('[retentionJobs] checkInactiveUsers', err));
}

export function startRetentionJobs() {
  if (!supabaseAdmin) {
    console.warn('[retentionJobs] Supabase non configuré — jobs de rétention désactivés.');
    return;
  }
  setTimeout(() => runAllRetentionJobs(), 45_000); // décalé du démarrage pour ne pas ralentir le boot
  setInterval(() => runAllRetentionJobs(), CHECK_INTERVAL_MS);
}
