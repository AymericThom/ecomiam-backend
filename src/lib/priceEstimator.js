// Estimateur de prix par ingrédient — bien plus réaliste que Math.random().
// Basé sur des prix moyens de grande distribution française (Leclerc/Carrefour,
// à actualiser régulièrement). Ce n'est PAS du scraping temps réel : dès que
// tu as accès à une vraie API produits (voir docs/SETUP.md > affiliation
// Drive), remplace ce fichier par un vrai appel à ce catalogue.
//
// Avant : un prix FIXE par ingrédient, peu importe la quantité — "poulet"
// coûtait 2.1€ que la ligne dise "100g" ou "800g". Comme les portions ne
// bougeaient jamais (toujours "pour 2"), l'erreur passait inaperçue. Elle
// devient flagrante dès que les foyers varient (1 à 8 personnes) : on
// calcule maintenant le prix à partir de la VRAIE quantité écrite dans la
// recette (grammes/ml/unités), pas juste de la présence du mot.

// Prix moyen pour 100g (ingrédients au poids)
const PRICE_PER_100G = [
  { match: /boeuf|bœuf|steak haché|bavette|entrecôte/i, price: 1.7 },
  { match: /poulet|dinde|volaille/i, price: 1.05 },
  { match: /porc|jambon|lardons|bacon/i, price: 0.95 },
  { match: /saumon|poisson frais|cabillaud|colin/i, price: 1.9 },
  { match: /thon en boîte|thon au naturel|maquereau/i, price: 0.9 },
  { match: /crevette/i, price: 1.75 },
  { match: /fromage|emmental|comté|chèvre|feta|parmesan|mozzarella/i, price: 1.3 },
  { match: /beurre/i, price: 1.1 },
  { match: /crème/i, price: 0.6 },
  { match: /riz|pâtes|semoule|boulgour|quinoa/i, price: 0.25 },
  { match: /pain|farine/i, price: 0.2 },
  { match: /tomate/i, price: 0.35 },
  { match: /courgette|aubergine|poivron|carotte|brocoli|épinard|chou/i, price: 0.35 },
  { match: /salade|laitue|roquette/i, price: 0.6 },
  { match: /champignon/i, price: 0.6 },
  { match: /lentille|pois chiche|haricot/i, price: 0.35 },
];

// Prix moyen pour 100ml (ingrédients liquides)
const PRICE_PER_100ML = [
  { match: /lait/i, price: 0.09 },
  { match: /huile/i, price: 0.6 },
];

// Prix à l'unité (ingrédients comptables — pas de quantité en poids logique)
const PRICE_PER_UNIT = [
  { match: /oeuf|œuf/i, price: 0.35 },
  { match: /yaourt/i, price: 0.3 },
  { match: /citron/i, price: 0.4 },
  { match: /avocat/i, price: 1.3 },
  { match: /oignon|échalote/i, price: 0.3 },
  { match: /gousse d'ail|gousses d'ail/i, price: 0.05 },
];

// Prix quasi fixe quelle que soit la quantité écrite (assaisonnement — l'unité
// de mesure réelle est trop faible pour peser sur le budget)
const FLAT_PRICE = [
  { match: /épice|herbe|sel|poivre|persil|basilic|thym|laurier|cumin|paprika/i, price: 0.15 },
];

const DEFAULT_PRICE_PER_100G = 0.8; // ingrédient non reconnu : estimation prudente
const DEFAULT_PORTION_G = 120; // si aucune quantité n'est détectée dans la ligne

function parseQuantity(line) {
  const weight = line.match(/(\d+(?:[.,]\d+)?)\s*(kg|g)\b/i);
  if (weight) {
    let grams = parseFloat(weight[1].replace(',', '.'));
    if (/kg/i.test(weight[2])) grams *= 1000;
    return { grams };
  }
  const volume = line.match(/(\d+(?:[.,]\d+)?)\s*(l|cl|ml)\b/i);
  if (volume) {
    let ml = parseFloat(volume[1].replace(',', '.'));
    if (/^l$/i.test(volume[2])) ml *= 1000;
    if (/cl/i.test(volume[2])) ml *= 10;
    return { ml };
  }
  const unit = line.match(/^(\d+)\s/);
  if (unit) return { count: parseInt(unit[1], 10) };
  return {};
}

export function estimateIngredientPrice(ingredientLine) {
  const flat = FLAT_PRICE.find((p) => p.match.test(ingredientLine));
  if (flat) return flat.price;

  const qty = parseQuantity(ingredientLine);

  const perUnit = PRICE_PER_UNIT.find((p) => p.match.test(ingredientLine));
  if (perUnit) return Math.round(perUnit.price * (qty.count || 1) * 100) / 100;

  const per100ml = PRICE_PER_100ML.find((p) => p.match.test(ingredientLine));
  if (per100ml) {
    const ml = qty.ml ?? DEFAULT_PORTION_G;
    return Math.round((per100ml.price / 100) * ml * 100) / 100;
  }

  const per100g = PRICE_PER_100G.find((p) => p.match.test(ingredientLine));
  const rate = per100g ? per100g.price : DEFAULT_PRICE_PER_100G;
  const grams = qty.grams ?? qty.ml ?? DEFAULT_PORTION_G;
  return Math.round((rate / 100) * grams * 100) / 100;
}

// Calcule le prix par portion d'une recette à partir de ses VRAIS ingrédients,
// au lieu de faire confiance au chiffre que Gemini invente. C'est ce chiffre
// qui doit être stocké/affiché comme pricePerServing, jamais celui du modèle.
export function estimateRecipePricePerServing(ingredientLines, servings = 1) {
  const total = (ingredientLines || []).reduce((sum, line) => sum + estimateIngredientPrice(line), 0);
  return Math.round((total / Math.max(1, servings)) * 100) / 100;
}
