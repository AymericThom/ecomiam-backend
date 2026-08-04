// Enregistre ton endpoint (/api/webhooks/risc) auprès de l'API RISC de
// Google, pour que Google commence à t'envoyer les événements de sécurité
// (protection multicompte). À lancer UNE SEULE FOIS après un déploiement
// (ou à nouveau si tu changes de domaine backend).
//
// Prérequis (voir RISC_SETUP.md pour le détail) :
//  1. API RISC activée sur ton projet Google Cloud
//  2. Un compte de service créé, avec le rôle nécessaire pour appeler l'API
//     RISC, et sa clé JSON téléchargée
//  3. GOOGLE_RISC_SERVICE_ACCOUNT_KEY_PATH pointant vers ce fichier JSON
//  4. RISC_RECEIVER_URL = l'URL publique de ton backend + /api/webhooks/risc
//
// Lancement : npm run risc:register

import 'dotenv/config';
import { GoogleAuth } from 'google-auth-library';

const RISC_API_BASE = 'https://risc.googleapis.com/v1beta';
const SCOPES = ['https://www.googleapis.com/auth/risc.security_events.subscribe'];

async function main() {
  const keyPath = process.env.GOOGLE_RISC_SERVICE_ACCOUNT_KEY_PATH;
  const receiverUrl = process.env.RISC_RECEIVER_URL;

  if (!keyPath) {
    console.error('❌ GOOGLE_RISC_SERVICE_ACCOUNT_KEY_PATH manquant dans .env — voir RISC_SETUP.md');
    process.exit(1);
  }
  if (!receiverUrl) {
    console.error('❌ RISC_RECEIVER_URL manquant dans .env (ex: https://ton-backend.onrender.com/api/webhooks/risc)');
    process.exit(1);
  }

  const auth = new GoogleAuth({ keyFile: keyPath, scopes: SCOPES });
  const client = await auth.getClient();

  console.log('🔧 Enregistrement de l\'endpoint RISC :', receiverUrl);

  // stream.update : configure (ou met à jour) le flux d'événements —
  // endpoint de réception + quels types d'événements on veut recevoir.
  await client.request({
    url: `${RISC_API_BASE}/stream:update`,
    method: 'POST',
    data: {
      delivery: {
        delivery_method: 'https://schemas.openid.net/secevent/risc/delivery-method/push',
        url: receiverUrl,
      },
      events_requested: [
        'https://schemas.openid.net/secevent/risc/event-type/sessions-revoked',
        'https://schemas.openid.net/secevent/risc/event-type/tokens-revoked',
        'https://schemas.openid.net/secevent/risc/event-type/account-disabled',
        'https://schemas.openid.net/secevent/risc/event-type/account-enabled',
        'https://schemas.openid.net/secevent/risc/event-type/account-purged',
        'https://schemas.openid.net/secevent/risc/event-type/account-credential-change-required',
        'https://schemas.openid.net/secevent/risc/event-type/verification',
      ],
    },
  });

  console.log('✅ Flux configuré. Envoi d\'un événement de test...');

  // Demande à Google de nous envoyer immédiatement un événement "verification"
  // de test, pour confirmer que tout fonctionne bout en bout.
  await client.request({
    url: `${RISC_API_BASE}/stream:verify`,
    method: 'POST',
    data: { state: 'test-depuis-registerRiscEndpoint' },
  });

  console.log('✅ Événement de test envoyé — regarde les logs de ton backend,');
  console.log('   tu devrais voir "[risc] événement de vérification reçu avec succès" sous peu.');
}

main().catch((e) => {
  console.error('❌ Échec de l\'enregistrement RISC :', e.response?.data || e.message);
  process.exit(1);
});
