import { supabaseAdmin } from './supabaseAdmin.js';

// Détermine si la requête vient d'un utilisateur PRO — utilisé pour la
// priorité dans la file d'attente Gemini (voir gemini.js). Volontairement
// vérifié CÔTÉ SERVEUR à partir du token Supabase envoyé dans l'en-tête
// Authorization, jamais à partir d'un champ envoyé par le client (qui
// pourrait facilement mentir en disant "isPremium: true" pour resquiller).
//
// Si la requête n'a pas de token (utilisateur anonyme, X-Device-Id
// seulement) ou que la vérification échoue pour une raison quelconque, on
// considère par défaut que ce n'est PAS un utilisateur PRO — c'est la
// direction sûre en cas de doute (au pire un abonné PRO mal identifié
// attend un peu plus longtemps, jamais l'inverse).
export async function isPremiumRequest(req) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ') || !supabaseAdmin) return false;

    const token = authHeader.slice('Bearer '.length);
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userData?.user) return false;

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('is_pro')
      .eq('id', userData.user.id)
      .single();
    if (profileError) return false;

    return !!profile?.is_pro;
  } catch {
    return false;
  }
}
