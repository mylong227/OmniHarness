# luhn

- `isValidCard(number)`：Luhn 校验；忽略空格/连字符；非数字 false。
- `generateCheckDigit(partial)`：计算使 Luhn 通过的校验位。
- `maskCard(number)`：保留后 4 位，其余换 `*`；长度 <=4 原样。
