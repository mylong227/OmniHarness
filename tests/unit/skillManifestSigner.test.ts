/**
 * 技能签名分发判据：Ed25519 签名/验签 + `--skills` 加载时的可信公钥校验。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillManifestSigner } from '../../src/skill/skillManifestSigner.ts';
import { CliSkillFlags } from '../../src/cli/cliSkillFlags.ts';

const SKILLS = [
  {
    name: 'review',
    description: '审查',
    instructions: '按审查清单执行。',
    tags: ['code'],
  },
];

test('签名/验签：通过、篡改失败、可信公钥不匹配失败', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const manifest = SkillManifestSigner.sign(SKILLS, privatePem);
  assert.strictEqual(SkillManifestSigner.verify(manifest), true);
  assert.strictEqual(SkillManifestSigner.verify(manifest, publicPem), true);
  assert.strictEqual(
    SkillManifestSigner.verify({ ...manifest, skills: [{ ...SKILLS[0]!, description: '篡改' }] }),
    false,
  );
  const other = generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'pem',
  });
  assert.strictEqual(SkillManifestSigner.verify(manifest, other.toString()), false);
});

test('--skills：签名包无信任锚拒绝，可信公钥通过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-signed-'));
  const previous = process.env.OMNI_SKILL_TRUSTED_KEY;
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signedPath = join(dir, 'skills.json');
    const publicPath = join(dir, 'public.pem');
    writeFileSync(
      signedPath,
      JSON.stringify(
        SkillManifestSigner.sign(
          SKILLS,
          privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        ),
      ),
    );
    writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }).toString());
    delete process.env.OMNI_SKILL_TRUSTED_KEY;
    assert.throws(
      () =>
        CliSkillFlags.resolve({ skillsFile: [signedPath] }, (path) => readFileSync(path, 'utf8')),
      /OMNI_SKILL_TRUSTED_KEY/u,
    );
    process.env.OMNI_SKILL_TRUSTED_KEY = publicPath;
    const skills = CliSkillFlags.resolve({ skillsFile: [signedPath] }, (path) =>
      readFileSync(path, 'utf8'),
    );
    assert.strictEqual(skills[0]?.name, 'review');
  } finally {
    if (previous === undefined) delete process.env.OMNI_SKILL_TRUSTED_KEY;
    else process.env.OMNI_SKILL_TRUSTED_KEY = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
