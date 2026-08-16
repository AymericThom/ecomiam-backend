import { supabaseAdmin } from './supabaseAdmin.js';

// ⚡ NOUVEAU : met à jour la série de jours consécutifs actifs.
//
// Appelé depuis middleware/requireAuth.js à CHAQUE requête API authentifiée
// (fire-and-forget, jamais attendu — ne doit jamais ralentir une requête
// utilisateur), donc le tracking démarre immédiatement pour tout le monde
// SANS modification côté mobile ni nouvel appel réseau dédié. routes/streak.js
// expose ensuite ces chiffres pour affichage ("🔥 12 jours d'affilée").
//
// Ce compteur sert aussi de signal de "rétention confirmée" pour les
// récompenses de parrainage différées (voir lib/retentionJobs.js) : un
// filleul qui n'atteint jamais current_streak >= 2 n'a fait qu'installer
// l'app une fois, et ne déclenche jamais la récompense de son parrain —
// c'est volontaire, ça aligne l'incitation du parrain sur la vraie
// rétention plutôt que sur le simple nombre d'inscriptions.
export async function touchStreak(userId) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('last_active_date, current_streak, longest_streak')
      .eq('id', userId)
      .single();
    if (!profile) return; // profil pas encore créé (trigger Supabase en cours) — rien à faire pour l'instant
    if (profile.last_active_date === today) return; // déjà compté aujourd'hui, on ne touche rien

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const continuesStreak = profile.last_active_date === yesterday;
    const newStreak = continuesStreak ? (profile.current_streak || 0) + 1 : 1;

    await supabaseAdmin
      .from('profiles')
      .update({
        last_active_date: today,
        current_streak: newStreak,
        longest_streak: Math.max(newStreak, profile.longest_streak || 0),
      })
      .eq('id', userId);
  } catch (err) {
    // Une erreur ici ne doit JAMAIS remonter jusqu'à la requête utilisateur
    // en cours (voir l'appel fire-and-forget dans requireAuth.js).
    console.error('[streaks] mise à jour échouée pour', userId, err);
  }
}
