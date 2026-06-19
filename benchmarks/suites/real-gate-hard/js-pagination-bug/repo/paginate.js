// BUG: pages are 1-indexed but this slices as if 0-indexed, and totalPages
// truncates instead of rounding up.
module.exports = function paginate(items, page, perPage) {
  const start = page * perPage;
  return {
    items: items.slice(start, start + perPage),
    page,
    perPage,
    totalPages: Math.floor(items.length / perPage),
  };
};
