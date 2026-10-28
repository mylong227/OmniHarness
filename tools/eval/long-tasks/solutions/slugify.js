function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function truncateSlug(slug, max) {
  if (slug.length <= max) return slug;
  let cut = slug.slice(0, Math.max(0, max));
  if (!cut.endsWith('-') && slug[max] !== '-') {
    const at = cut.lastIndexOf('-');
    if (at > 0) cut = cut.slice(0, at);
  }
  return cut.replace(/-+$/g, '');
}

function isValidSlug(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

module.exports = { slugify, truncateSlug, isValidSlug };
