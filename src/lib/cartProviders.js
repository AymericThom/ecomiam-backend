// Interface commune pour "pousser" un panier ÉcoMiam vers un Drive de
// supermarché. Aujourd'hui un seul provider "mock" est branché ; le jour où
// tu as un accès Miam.tech / Awin / Carrefour Developer (voir docs/SETUP.md
// > section 7), tu ajoutes un fichier ici (ex: miamtech.js) qui implémente
// la même fonction pushCart(items) et tu le branches dans routes/cart.js.

export async function pushCartMock(items) {
  // Simule un délai réseau réaliste pour que l'UI mobile ait un vrai
  // comportement de chargement à tester.
  await new Promise((r) => setTimeout(r, 600));
  return {
    status: 'coming_soon',
    message: "L'envoi direct vers votre Drive arrive bientôt ! On vous prévient dès que c'est prêt.",
    itemsCount: items.length,
  };
}

/*
Exemple de ce à quoi ressemblera un vrai provider (Miam.tech) :

export async function pushCartMiamTech(items, { retailer, userToken }) {
  const res = await fetch('https://api.miam.tech/v1/cart/push', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.MIAMTECH_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ retailer, items, userToken }),
  });
  const data = await res.json();
  return { status: 'redirect', url: data.checkoutUrl, itemsCount: items.length };
}
*/
