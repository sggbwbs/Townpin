// Flat rate -- 10€ per slot regardless of quantity. Replaced the old
// volume-discount model (5€, 4€ at 4+) entirely; size and prestige
// (gold border at 4, legendary at 5) are now what scales with quantity,
// not price per slot.
function pricePerSquareEur(count) {
  return 10;
}

module.exports = { pricePerSquareEur };
