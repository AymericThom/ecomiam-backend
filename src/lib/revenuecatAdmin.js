// ⚡ NOUVEAU : accorde du PRO "gratuit" à un utilisateur SANS passer par un
// vrai achat App Store/Google Play, via l'API REST de RevenueCat
// ("promotional entitlement"). C'est le mécanisme utilisé pour toutes les
// récompenses de parrainage (lib/retentionJobs.js, routes/referral.js).
// Doc officielle : https://www.revenuecat.com/docs/api-v1#tag/entitlements/operation/grant-a-promotional-entitlement
//
// ⚠️ Étape MANUELLE requise : vérifie que REVENUECAT_ENTITLEMENT_ID (.env)
// correspond EXACTEMENT à l'identifiant de ton "entitlement" configuré dans
// RevenueCat > Entitlements (probablement "premium" ou "pro" — regarde le
// dashboard, c'est le même identifiant que celui vérifié côté mobile pour
// débloquer les features PRO). Un mauvais identifiant fait échouer l'appel
// silencieusement niveau UX : on logge l'erreur mais on ne fait JAMAIS
// planter le flux de parrainage pour ça (mieux vaut un utilisateur qui
// n'a pas reçu son cadeau qu'un crash de l'app).

const REVENUECAT_API_BASE = 'https://api.revenuecat.com/v1';

// RevenueCat exige une "duration" prédéfinie plutôt qu'un nombre de jours
// arbitraire. On choisit la plus proche EN DESSOUS de la demande — on
// préfère toujours sous-délivrer légèrement plutôt que sur-délivrer un
// avantage qu'on ne pourra pas reprendre facilement.
function pickDuration(days) {
  if (days >= 365) return 'yearly';
  if (days >= 90) return 'three_month';
  if (days >= 30) return 'monthly';
  if (days >= 7) return 'weekly';
  return 'daily';
}

// appUserId = l'UUID Supabase de l'utilisateur (même identifiant que celui
// passé à RevenueCat côté mobile lors du login — voir docs/SETUP.md).
export async function grantPromotionalDays(appUserId, days) {
  const apiKey = process.env.REVENUECAT_SECRET_KEY;
  // "pro" = même identifiant que celui vérifié côté mobile dans
  // src/payments/purchases.js (customerInfo.entitlements.active.pro).
  const entitlementId = process.env.REVENUECAT_ENTITLEMENT_ID || 'pro';

  if (!apiKey) {
    console.warn(
      '[revenuecatAdmin] REVENUECAT_SECRET_KEY manquante — récompense PRO NON accordée (mode simulé). Voir lib/revenuecatAdmin.js.',
    );
    return { simulated: true };
  }

  const duration = pickDuration(days);
  const res = await fetch(
    `${REVENUECAT_API_BASE}/subscribers/${encodeURIComponent(appUserId)}/entitlements/${encodeURIComponent(entitlementId)}/promotional`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ duration }),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`RevenueCat promotional grant échoué (${res.status}) ${detail}`);
  }
  return res.json();
}
