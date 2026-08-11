import { z } from 'zod';

// Validation des données ENTRANTES du mobile (avant même d'appeler OpenAI).
// Bloque les payloads malformés, trop longs, ou les tentatives d'injection
// de prompt via des champs censés être des listes fermées.
export const UserStateSchema = z.object({
  goals: z.array(z.enum(['weight_loss', 'muscle', 'economy', 'discover'])).max(4).default([]),
  adults: z.number().int().min(1).max(12),
  kids: z.number().int().min(0).max(12),
  budget: z.number().min(1).max(30),
  time: z.enum(['under10', 'around15', 'over15']),
  diet: z.enum(['none', 'vegetarian', 'vegan', 'pescatarian']),
  allergies: z.array(z.enum([
    'gluten', 'lactose', 'crustaces', 'oeufs', 'poissons', 'soja', 
    'arachides', 'fruits_coque', 'celeri', 'moutarde', 'mollusques', 'sesame'
  ])).max(12).default([]),
  customAllergies: z.array(z.string()).max(15).default([]),
  lovedIngredients: z.array(z.string()).max(25).default([]),
  dislikedIngredients: z.array(z.string()).max(25).default([]),
  equipment: z.array(z.string()).default([]),
  
  // 👇 AJOUTE CECI ICI
  mealsCount: z.number().int().min(1).max(14).default(7),
});

export const HintSchema = z.string().trim().max(200).optional();
export const ExcludeLabelsSchema = z.array(z.string().max(120)).max(20).optional();


export const RecipeSchema = z.object({
  label: z.string().min(2),
  searchQuery: z.string().min(2),
  totalTime: z.number().positive(),
  servings: z.number().positive(),
  difficulty: z.enum(['Facile', 'Moyen', 'Difficile']),
  calories: z.number().nonnegative(),
  protein: z.number().nonnegative(),
  carbs: z.number().nonnegative(),
  fat: z.number().nonnegative(),
  equipment: z.array(z.string()).default([]),
  // Une "vraie" recette a un minimum d'ingrédients et d'étapes. min(1) laissait
  // passer des recettes creuses (1 ingrédient, 1 étape) — c'était la cause
  // principale des recettes "vides" signalées.
  ingredientLines: z.array(z.string().min(4)).min(3),
  // Recettes ultra détaillées : au moins 5 étapes atomiques (une action par
  // étape), chacune assez longue pour contenir geste + quantité + durée/température.
  steps: z.array(z.string().min(25)).min(5),
  // Conseils de chef — nouveau champ, optionnel côté schéma pour ne jamais
  // faire échouer une génération si le modèle l'omet, mais demandé par le prompt.
  tips: z.array(z.string().min(4)).max(3).default([]),
})
  // Les macros doivent être mathématiquement cohérentes avec les calories
  // annoncées — le prompt le demande déjà, mais rien ne le VÉRIFIAIT. Sans
  // ce refine, un modèle qui invente des chiffres incohérents passait quand
  // même la validation.
  .refine(
    (r) => Math.abs(r.protein * 4 + r.carbs * 4 + r.fat * 9 - r.calories) <= 60,
    { message: 'Incohérence macros/calories (protéines×4 + glucides×4 + lipides×9 doit ≈ calories)' }
  );

// Variante avec contraintes complètes selon le profil utilisateur — rejette
// une recette "prise de masse" trop peu calorique, "perte de poids" trop
// calorique, ET une recette dont "servings" ne correspond pas au vrai foyer
// (adults+kids). Ce dernier point manquait complètement avant : le champ
// existait dans UserStateSchema mais rien ne vérifiait qu'il était respecté,
// donc tout sortait "pour 2" par défaut quel que soit le foyer réel.
export function RecipeSchemaForRequest(userState = {}) {
  const goals = userState.goals || [];
  const totalDiners = (userState.adults || 2) + (userState.kids || 0);
  let schema = RecipeSchema;
  if (goals.includes('weight_loss')) {
    schema = schema.refine((r) => r.calories <= 480, { message: 'Trop calorique pour un objectif perte de poids (max 450-480 kcal/portion)' });
  }
  if (goals.includes('muscle')) {
    schema = schema.refine((r) => r.protein >= 32, { message: 'Pas assez de protéines pour un objectif prise de masse (min 35g/portion)' });
  }
  schema = schema.refine((r) => r.servings === totalDiners, {
    message: `servings doit être exactement ${totalDiners} (foyer réel de l'utilisateur), pas une valeur générique`,
  });
  return schema;
}

// `count` est variable : la banque de recettes peut déjà fournir une partie
// de la semaine, on ne demande à l'IA que le nombre de recettes manquantes.
// `userState` (optionnel) applique en plus les contraintes de goal + foyer
// réel (voir RecipeSchemaForRequest).
export function WeekResponseSchema(count = 7, userState = {}) {
  return z.object({ days: z.array(RecipeSchemaForRequest(userState)).length(count) });
}

export function FridgeResponseSchema(userState = {}) {
  return z.object({
    detectedItems: z.array(z.string()),
    recipe: RecipeSchemaForRequest(userState),
  });
}

// Parse défensif : le modèle répond parfois avec du texte autour du JSON
// malgré les instructions — on extrait le premier bloc { ... } valide.
export function safeParseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw e;
  }
}
