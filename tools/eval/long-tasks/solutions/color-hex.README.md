# color-hex

- `normalizeHex('#abc')`：规范成 `#aabbcc`；非法返回 null。
- `hexToRgb('#ff0000')`：返回 `{r,g,b}`；非法抛错。
- `rgbToHex(255,0,0)`：返回小写 `#rrggbb`；越界抛错。
