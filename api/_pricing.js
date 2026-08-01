// Flat rate -- 29.90€ per slot regardless of quantity or tier. Size no
// longer scales with how many slots someone buys either -- gold-border
// and legendary tiers are removed for now (may come back later), so
// every listing gets the same size ad at the same price.
function pricePerSquareEur(count) {
  return 29.90;
}

module.exports = { pricePerSquareEur };
