// Volume pricing -- more squares in one purchase costs less per square.
// Shared between the initial purchase flow and the self-service "add
// more slots" flow so they can never quietly drift apart into two
// different prices for the same tier.
function pricePerSquareEur(count) {
  if (count >= 4) return 4;
  return 5;
}

module.exports = { pricePerSquareEur };
