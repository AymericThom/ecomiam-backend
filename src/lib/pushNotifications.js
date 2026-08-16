// ⚡ NOUVEAU : envoi de notifications push via l'API Expo — utilisé pour les
// relances de rétention (lib/retentionJobs.js) : streak sur le point de se
// casser, inactivité prolongée, récompense de parrainage débloquée.
//
// La table `push_tokens` était déjà référencée en commentaire dans
// routes/account.js (cascade de suppression) mais rien ne l'alimentait
// jusqu'ici : routes/push.js expose maintenant l'enregistrement du token,
// à appeler côté mobile juste après `Notifications.getExpoPushTokenAsync()`
// (voir mobile/src/notifications/notifications.js pour le pattern existant
// de notifications LOCALES déjà en place — ceci ajoute les notifications
// SERVEUR, qui fonctionnent même si l'app n'a pas été rouverte récemment).

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export async function sendPushToUser(supabaseAdmin, userId, { title, body, data }) {
  if (!supabaseAdmin) return;
  const { data: tokens, error } = await supabaseAdmin
    .from('push_tokens')
    .select('expo_push_token')
    .eq('user_id', userId);
  if (error || !tokens?.length) return; // pas de token connu (notifs désactivées, ou table pas encore migrée) → rien à faire

  const messages = tokens.map((t) => ({
    to: t.expo_push_token,
    title,
    body,
    data: data || {},
    sound: 'default',
  }));

  try {
    await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });
  } catch (err) {
    // Un échec d'envoi push ne doit jamais faire planter le job de
    // rétention qui l'a déclenché — les autres utilisateurs doivent quand
    // même recevoir le leur.
    console.error('[push] envoi échoué pour', userId, err);
  }
}
