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
      .select('is_pro, family_group_id')
      .eq('id', userData.user.id)
      .single();
    if (profileError) return false;
    if (profile?.is_pro) return true;

    // ⚡ NOUVEAU : filet de sécurité pour le plan famille — si la personne a
    // rejoint le groupe APRÈS l'achat (le webhook ne propage le PRO qu'au
    // moment de l'achat/renouvellement, voir routes/revenuecatWebhook.js),
    // son propre is_pro peut être encore à false alors que son groupe a
    // bien un abonnement famille actif. Vérifié en direct ici plutôt que
    // de dépendre uniquement du timing du webhook.
    if (profile?.family_group_id) {
      const { data: familyPro } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('family_group_id', profile.family_group_id)
        .eq('is_pro', true)
        .eq('pro_source', 'own')
        .limit(1)
        .maybeSingle();
      if (familyPro) return true;
    }

    return false;
  } catch {
    return false;
  }
}
