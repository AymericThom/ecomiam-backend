import 'dotenv/config';
import * as Sentry from '@sentry/node';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

import { recipesRouter } from './routes/recipes.js';
import { fridgeRouter } from './routes/fridge.js';
import { cartRouter } from './routes/cart.js';
import { accountRouter } from './routes/account.js';
import { revenuecatWebhookRouter } from './routes/revenuecatWebhook.js';
import { riscEventsRouter } from './routes/riscEvents.js';
import { identifyRequester } from './middleware/requireAuth.js';
import { checkDailyQuota } from './middleware/checkDailyQuota.js';
import { ensureRecipeImageBucket } from './lib/imageGen.js';

// --- Garde-fou au démarrage : on préfère planter tout de suite en prod
// plutôt que de tourner silencieusement sans clé Gemini et facturer des
// erreurs 500 en boucle.
if (process.env.NODE_ENV === 'production' && !process.env.GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY manquante en production — arrêt.');
  process.exit(1);
}

// Monitoring d'erreurs (voir docs/SETUP.md > section Sentry). Sans clé, ce
// bloc ne fait simplement rien — pas besoin de Sentry pour développer.
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.2, environment: process.env.NODE_ENV || 'development' });
}

const app = express();

app.set('trust proxy', 1); // nécessaire derrière Render/Railway pour un rate-limit fiable
app.use(helmet());
app.use(compression());

const allowedOrigins = (process.env.CORS_ORIGIN || '*').split(',').map((o) => o.trim());
app.use(cors({ origin: allowedOrigins.includes('*') ? true : allowedOrigins }));

// Les photos base64 du frigo peuvent être lourdes → limite relevée mais bornée.
app.use(express.json({ limit: '8mb' }));

// Anti-abus : limite par IP (protège même les utilisateurs non authentifiés
// en dev) — s'ajoute au quota par utilisateur (checkDailyQuota) en prod.
const aiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const cartLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120 });
const accountLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 }); // suppression de compte : rare, pas besoin de plus

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use('/api/recipes', aiLimiter, identifyRequester, checkDailyQuota, recipesRouter);
app.use('/api/fridge-scan', aiLimiter, identifyRequester, checkDailyQuota, fridgeRouter);
app.use('/api/cart', cartLimiter, identifyRequester, cartRouter);
app.use('/api/account', accountLimiter, identifyRequester, accountRouter);
app.use('/api/webhooks/revenuecat', revenuecatWebhookRouter);
// Protection multicompte (Cross-Account Protection / RISC) — voir
// RISC_SETUP.md pour l'enregistrement de cette URL auprès de Google.
app.use('/api/webhooks/risc', riscEventsRouter);

if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app);

// Gestionnaire d'erreur générique : ne jamais renvoyer la stack trace au client.
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Erreur serveur' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ ÉcoMiam backend démarré sur le port ${PORT}`);
  ensureRecipeImageBucket().catch(() => {});
});
