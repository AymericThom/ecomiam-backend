import { GoogleGenerativeAI } from '@google/generative-ai';

if (!process.env.GEMINI_API_KEY) {
  console.warn('[gemini] GEMINI_API_KEY manquante — les routes /recipes et /fridge échoueront.');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// "flash" = modèles rapides et gratuits en usage raisonnable (quota généreux
// sur https://aistudio.google.com — voir docs/SETUP.md pour le détail et
// vérifier le nom du modèle le plus récent, ça évolue régulièrement).
//
// FALLBACK DE MODÈLE : chaque liste contient [modèle principal, modèle de
// secours]. Quand le quota du modèle principal (3.1) est épuisé (429 /
// RESOURCE_EXHAUSTED) après les retries habituels, generateValidatedJSON
// bascule automatiquement sur le modèle suivant de la liste (3.5) au lieu
// d'abandonner — vérifie les noms exacts des modèles sur
// https://aistudio.google.com si jamais l'un des deux n'est pas reconnu.
export const TEXT_MODELS = [
  process.env.GEMINI_TEXT_MODEL_PRIMARY || 'gemini-3.1-flash-lite',
  process.env.GEMINI_TEXT_MODEL_FALLBACK || 'gemini-3.5-flash-lite',
];
export const VISION_MODELS = [
  process.env.GEMINI_VISION_MODEL_PRIMARY || 'gemini-3.1-flash-lite',
  process.env.GEMINI_VISION_MODEL_FALLBACK || 'gemini-3.5-flash-lite',
];
// Nano Banana — modèle de génération d'image de Gemini, sur la même clé API.
// Pas de nouveau provider à gérer : même compte, même facturation, même quota.
export const IMAGE_MODEL_NAME = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

/* ----------------------------------------------------------------------- */
/*  FILE D'ATTENTE GLOBALE — LE vrai fix anti "spam Gemini".               */
/*                                                                          */
/*  Toute ta clé API Gemini est PARTAGÉE entre tous les utilisateurs de    */
/*  l'app. Si 5 personnes cliquent "changer ce plat" à la même seconde,    */
/*  5 requêtes partent en même temps et tu te fais jeter par le rate-limit */
/*  du tier gratuit (RPM = requêtes par minute). Cette file d'attente      */
/*  sérialise TOUS les appels Gemini du serveur, avec un espacement        */
/*  minimum entre deux — quel que soit le nombre d'utilisateurs en même    */
/*  temps, jamais plus d'un appel Gemini toutes les MIN_INTERVAL_MS.       */
/*                                                                          */
/*  PRIORITÉ PRO : file à 2 voies plutôt qu'une simple chaîne FIFO — les   */
/*  requêtes marquées `priority: true` (utilisateurs PRO) sont traitées    */
/*  avant celles des utilisateurs gratuits déjà en attente (mais jamais    */
/*  avant une requête déjà en cours d'exécution — on ne peut pas          */
/*  interrompre un appel Gemini déjà parti). Concrètement : aux heures de */
/*  pointe, un abonné PRO passe devant la file, un vrai avantage           */
/*  fonctionnel, pas juste une étiquette marketing.                        */
/* ----------------------------------------------------------------------- */
const MIN_INTERVAL_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS || 4200);
const priorityQueue = [];
const normalQueue = [];
let lastCallAt = 0;
let workerRunning = false;

function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  (async () => {
    while (priorityQueue.length > 0 || normalQueue.length > 0) {
      const next = priorityQueue.shift() || normalQueue.shift();
      const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastCallAt = Date.now();
      try {
        next.resolve(await next.task());
      } catch (e) {
        next.reject(e);
      }
    }
    workerRunning = false;
  })();
}

function enqueue(task, { priority = false } = {}) {
  return new Promise((resolve, reject) => {
    (priority ? priorityQueue : normalQueue).push({ task, resolve, reject });
    runWorker();
  });
}

function isRateLimitError(err) {
  const msg = String(err?.message || err || '');
  return err?.status === 429 || /429|RESOURCE_EXHAUSTED|rate limit|quota/i.test(msg);
}

async function callGemini({ modelName, system, user, image, temperature, maxOutputTokens }) {
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: system,
    generationConfig: { responseMimeType: 'application/json', temperature, maxOutputTokens },
  });
  const parts = image ? [{ text: user }, { inlineData: { data: image.base64, mimeType: image.mimeType } }] : user;
  const result = await model.generateContent(parts);
  return result.response.text();
}

function safeParseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw e;
  }
}

// Erreur "propre" que les routes peuvent distinguer d'une vraie panne, pour
// renvoyer un message utilisateur clair plutôt qu'un 500 générique.
export class GeminiBusyError extends Error {
  constructor() {
    super('Trop de demandes en ce moment — réessaie dans une minute.');
    this.name = 'GeminiBusyError';
  }
}

// Génère une image via Gemini (Nano Banana) et renvoie les bytes bruts +
// mimeType. Passe par la même `enqueue()` que le texte pour ne jamais
// dépasser le rate-limit de la clé API, et le même backoff sur 429.
export async function generateImageBuffer(prompt, { priority = false } = {}) {
  const rateLimitBackoffs = [2000, 6000];
  let rateLimitAttempt = 0;
  while (true) {
    try {
      return await enqueue(async () => {
        const model = genAI.getGenerativeModel({
          model: IMAGE_MODEL_NAME,
          generationConfig: { responseModalities: ['Image'] },
        });
        const result = await model.generateContent(prompt);
        const parts = result.response.candidates?.[0]?.content?.parts || [];
        const imagePart = parts.find((p) => p.inlineData);
        if (!imagePart) throw new Error('Aucune image renvoyée par Gemini');
        return {
          buffer: Buffer.from(imagePart.inlineData.data, 'base64'),
          mimeType: imagePart.inlineData.mimeType || 'image/png',
        };
      }, { priority });
    } catch (e) {
      if (isRateLimitError(e)) {
        if (rateLimitAttempt >= rateLimitBackoffs.length) throw new GeminiBusyError();
        await new Promise((r) => setTimeout(r, rateLimitBackoffs[rateLimitAttempt]));
        rateLimitAttempt++;
        continue;
      }
      throw e;
    }
  }
}
// Génère du JSON, VALIDE avec un schéma zod, et gère deux types d'échecs :
//  1. JSON malformé / hors schéma → 1 retry immédiat avec une consigne plus stricte.
//  2. Rate-limit (429) → jusqu'à 2 retries avec backoff (2s, 6s) avant
//     d'abandonner proprement avec un message clair (GeminiBusyError).
// Tout appel passe par `enqueue()`, donc jamais deux appels Gemini en
// parallèle depuis ce serveur, quel que soit le nombre d'utilisateurs.
export async function generateValidatedJSON({ system, user, schema, image, temperature = 0.5, vision = false, priority = false, expectedRecipeCount = 1 }) {
  const models = vision ? VISION_MODELS : TEXT_MODELS;
  const rateLimitBackoffs = [2000, 6000];
  let jsonRetried = false;

  // ⚠️ Sans ça, une réponse volumineuse (ex: un lot de 20 recettes en une
  // seule requête, voir seedRecipeBank.js) peut être tronquée en plein
  // milieu par la limite de tokens de sortie par défaut du modèle — le
  // JSON devient invalide, ce qui déclenche un retry et ANNULE une partie
  // de l'économie recherchée en groupant les recettes. ~1200 tokens/recette
  // (recettes ultra détaillées = étapes plus longues + conseils du chef),
  // +2000 de marge pour le reste du JSON (structure, champs courts).
  const maxOutputTokens = Math.min(65536, expectedRecipeCount * 1200 + 2000);

  // Boucle EXTERNE sur les modèles (ex: [3.1 Flash Lite, 3.5 Flash Lite]) :
  // si le quota du modèle courant est épuisé après ses propres retries, on
  // passe au modèle suivant plutôt que d'abandonner. Boucle INTERNE : sur un
  // même modèle, retry avec backoff sur 429, et un seul retry sur JSON
  // invalide/hors-schéma (le compteur jsonRetried est partagé entre modèles
  // pour ne jamais boucler indéfiniment au total).
  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const modelName = models[modelIndex];
    const isLastModel = modelIndex === models.length - 1;
    let rateLimitAttempt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const raw = await enqueue(() =>
          callGemini({
            modelName,
            system,
            user: jsonRetried
              ? `${user}\n\nIMPORTANT : ta réponse précédente n'était pas un JSON valide selon le schéma demandé. Réponds STRICTEMENT avec un JSON valide, sans aucun texte autour.`
              : user,
            image,
            temperature,
            maxOutputTokens,
          }), { priority }
        );
        const parsed = safeParseJSON(raw);
        return schema.parse(parsed);
      } catch (e) {
        if (isRateLimitError(e)) {
          if (rateLimitAttempt < rateLimitBackoffs.length) {
            await new Promise((r) => setTimeout(r, rateLimitBackoffs[rateLimitAttempt]));
            rateLimitAttempt++;
            continue;
          }
          if (!isLastModel) {
            console.warn(`[gemini] quota épuisé sur ${modelName}, bascule sur ${models[modelIndex + 1]}`);
            break; // sort du while → passe au modèle suivant dans la boucle for
          }
          console.error('[gemini] rate-limit persistant sur tous les modèles', e.message);
          throw new GeminiBusyError();
        }
        // JSON malformé / validation zod échouée → un seul retry au total, pas de boucle infinie.
        if (!jsonRetried) {
          jsonRetried = true;
          continue;
        }
        throw e;
      }
    }
  }
}
