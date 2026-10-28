# slugify

- `slugify(text)`：转小写、去重音、非字母数字压成 `-`、去首尾与连续连字符。
- `truncateSlug(slug, max)`：按最大长度截断，且不留下尾部连字符。
- `isValidSlug(slug)`：只允许 `a-z0-9` 与单个 `-` 分隔。
