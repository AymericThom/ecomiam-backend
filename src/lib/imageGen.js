import { generateImageBuffer } from './gemini.js';
import { fetchRecipeImage } from './pexels.js';
import { supabaseAdmin } from './supabaseAdmin.js';

const BUCKET = 'recipe-images';

// Identité visuelle constante pour que toutes les photos de l'app se
// ressentent comme une vraie collection éditoriale, pas un patchwork de
// stock photos dépareillées. On décrit le PLAT RÉEL (nom + ingrédients
// principaux) au lieu de 3 mots-clés vagues envoyés à une recherche stock —
// c'est ce qui corrige le problème de fond : l'image ne correspondait pas
// au plat.
function buildImagePrompt(recipe) {
  const mainIngredients = (recipe.ingredientLines || [])
    .slice(0, 5)
    .map((line) => line.replace(/^\d+([.,]\d+)?\s*(g|kg|ml|l|cl)?\s*(de\s|d')?/i, ''))
    .join(', ');

  return `Photographie culinaire professionnelle du plat suivant, pour une application de nutrition haut de gamme.
Plat : "${recipe.label}".
Ingrédients principaux visibles dans l'assiette : ${mainIngredients}.
Style : vue légèrement plongeante (45°), lumière naturelle douce, arrière-plan minimal neutre (bois clair ou marbre clair), pas de texte ni de logo ni de watermark, pas de mains ni de personnes visibles, mise en scène épurée et appétissante, format carré, cohérent avec une identité de marque premium et healthy.
Le plat doit correspondre exactement aux ingrédients listés — pas d'improvisation sur le contenu de l'assiette.`;
}

function pathFor(recipe) {
  const slug = (recipe.label || 'recette')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug}-${Date.now()}.png`;
}

async function uploadToSupabase(buffer, mimeType, recipe) {
  if (!supabaseAdmin) return null;
  const path = pathFor(recipe);
  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: mimeType, upsert: true });
  if (error) {
    console.error('[imageGen] upload Supabase échoué', error.message);
    return null;
  }
  const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
}

// Génère une vraie photo du plat via Gemini (Nano Banana), l'héberge sur
// Supabase Storage, et renvoie son URL publique. Si la génération ou
// l'upload échoue pour une raison quelconque (quota, erreur réseau, bucket
// manquant...), on retombe sur l'ancienne recherche Pexels plutôt que de
// planter toute la génération de la recette pour une histoire de photo.
export async function generateRecipeImage(recipe, { priority = false } = {}) {
  // En dev/seed initial, générer une vraie photo par recette via Gemini est
  // lent (retries de rate-limit à chaque appel) et pas nécessaire : Pexels
  // suffit largement pour avoir des données de test. Mets
  // SKIP_GEMINI_IMAGE_GEN=false dans .env quand tu voudras les vraies photos
  // cohérentes pour la prod.
  if (process.env.SKIP_GEMINI_IMAGE_GEN === 'true') {
    return fetchRecipeImage(recipe.searchQuery);
  }
  try {
    const { buffer, mimeType } = await generateImageBuffer(buildImagePrompt(recipe), { priority });
    const url = await uploadToSupabase(buffer, mimeType, recipe);
    if (url) return url;
  } catch (e) {
    console.error('[imageGen] génération Gemini échouée, repli Pexels', e.message);
  }
  return fetchRecipeImage(recipe.searchQuery);
}

export async function attachGeneratedImages(recipes, { priority = false } = {}) {
  return Promise.all(recipes.map(async (r) => ({ ...r, image: r.image || (await generateRecipeImage(r, { priority })) })));
}

// Crée le bucket au démarrage du serveur si besoin (idempotent — ignore
// l'erreur "already exists"). Bucket public : les images de recettes n'ont
// rien de sensible et doivent être servies directement à l'app mobile.
export async function ensureRecipeImageBucket() {
  if (!supabaseAdmin) return;
  try {
    const { error } = await supabaseAdmin.storage.createBucket(BUCKET, { public: true });
    if (error && !/already exists/i.test(error.message)) {
      console.error('[imageGen] création du bucket échouée', error.message);
    }
  } catch (e) {
    console.error('[imageGen] création du bucket échouée', e.message);
  }
}
