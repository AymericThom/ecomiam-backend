// Récupère une photo réaliste pour illustrer une recette générée par l'IA
// (le LLM ne peut pas fournir de vraie URL d'image). Utilise l'API Pexels
// (gratuite) — Aymeric en a probablement déjà une clé pour son pipeline
// vidéo Hors Champ, sinon : https://www.pexels.com/api/

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const FALLBACK_IMAGE = 'https://images.pexels.com/photos/1279330/pexels-photo-1279330.jpeg';

const cache = new Map(); // évite de re-appeler Pexels pour la même recherche

export async function fetchRecipeImage(searchQuery) {
  if (!PEXELS_API_KEY) return FALLBACK_IMAGE;
  const query = (searchQuery || 'french home cooking').trim();
  if (cache.has(query)) return cache.get(query);

  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query + ' food dish')}&per_page=1&orientation=square`,
      { headers: { Authorization: PEXELS_API_KEY } }
    );
    const data = await res.json();
    const url = data?.photos?.[0]?.src?.large || FALLBACK_IMAGE;
    cache.set(query, url);
    return url;
  } catch (e) {
    return FALLBACK_IMAGE;
  }
}
