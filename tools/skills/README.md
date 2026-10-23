# 技能包签名

```bash
npm run skill:sign -- --input skills.json --key private.pem --out signed.json
npm run skill:verify -- --input signed.json --trusted-key public.pem
```

签名对象是声明式技能子集（name/description/instructions/tags）的规范化 JSON；Ed25519。
使用 `--skills signed.json` 时必须设置 `OMNI_SKILL_TRUSTED_KEY=<public.pem>`，否则拒绝加载。
