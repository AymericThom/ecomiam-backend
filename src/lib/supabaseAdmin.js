import { createClient } from '@supabase/supabase-js';

// Client "admin" — utilise la clé service_role, réservé au backend.
// Ne JAMAIS mettre SUPABASE_SERVICE_ROLE_KEY dans le code mobile.
export const supabaseAdmin =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

if (!supabaseAdmin) {
  console.warn('[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquantes — sync PRO désactivée.');
}
