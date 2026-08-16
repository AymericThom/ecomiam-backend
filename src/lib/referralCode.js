import { supabaseAdmin } from './supabaseAdmin.js';

// Alphabet sans 0/O/1/I — évite la confusion quand le code est lu à voix
// haute ou recopié à la main (cas fréquent : "regarde, mon code c'est...").
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(length = 6) {
  let code = '';
  for (let i = 0; i < length; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return code;
}

// Idempotent : si le profil a déjà un code, on le renvoie tel quel SANS le
// régénérer (les utilisateurs partagent ce code sur WhatsApp/Instagram —
// le changer casserait tous les liens déjà envoyés). Sinon on en génère un
// nouveau, avec quelques tentatives en cas de collision (improbable avec 6
// caractères sur un alphabet de 33 = ~1 milliard de combinaisons, mais la
// contrainte UNIQUE en base reste le vrai filet de sécurité).
export async function getOrCreateReferralCode(userId) {
  const { data: existing } = await supabaseAdmin
    .from('profiles')
    .select('referral_code')
    .eq('id', userId)
    .single();
  if (existing?.referral_code) return existing.referral_code;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ referral_code: code })
      .eq('id', userId)
      .is('referral_code', null); // évite d'écraser un code généré entre-temps par une requête concurrente

    if (!error) {
      const { data: check } = await supabaseAdmin.from('profiles').select('referral_code').eq('id', userId).single();
      if (check?.referral_code) return check.referral_code;
    }
    // error non-null = très probablement une collision sur la contrainte
    // UNIQUE(referral_code) → on retente avec un nouveau code aléatoire.
  }
  throw new Error('Impossible de générer un code de parrainage unique après 5 tentatives');
}
