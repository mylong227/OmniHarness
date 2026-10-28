# query-string

- `parseQuery('a=1&b=hi')`：解析为对象；`+` 视为空格；无值键为空串。
- `buildQuery({a:'1'})`：`encodeURIComponent` 后按对象顺序拼接。
- `getQueryParam(query, key)`：取单个参数；不存在返回 undefined。
