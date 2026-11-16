import { describe, expect, it } from 'vitest';
import {
  createRunnerSchema,
  deleteRunnerSchema,
  helmCommands,
  parseTags,
  registrationCommand,
  runnerTargetSchema,
  searchTargetsSchema,
  setRunnerPausedSchema,
} from '@/lib/runner-rules';

const base = {
  target: { type: 'instance_type' as const },
  tags: ['docker'],
  runUntagged: false,
  locked: false,
  protectedRefs: false,
  paused: false,
  maximumTimeout: null,
  reason: 'CHG0100 - novo runner compartilhado',
};
const ok = (v: unknown) => createRunnerSchema.safeParse(v).success;

describe('createRunnerSchema', () => {
  it('aceita global, de grupo e de projeto', () => {
    expect(ok(base)).toBe(true);
    expect(ok({ ...base, target: { type: 'group_type', id: 7 } })).toBe(true);
    expect(ok({ ...base, target: { type: 'project_type', id: 9 }, locked: true })).toBe(true);
  });
  it('alvo: grupo/projeto exigem id inteiro positivo', () => {
    expect(ok({ ...base, target: { type: 'group_type' } })).toBe(false);
    expect(ok({ ...base, target: { type: 'project_type', id: 0 } })).toBe(false);
    expect(ok({ ...base, target: { type: 'group_type', id: 1.5 } })).toBe(false);
    expect(ok({ ...base, target: { type: 'outro' } })).toBe(false);
  });
  it('sem tag só vale se permitir jobs sem tag', () => {
    expect(ok({ ...base, tags: [] })).toBe(false);
    expect(ok({ ...base, tags: [], runUntagged: true })).toBe(true);
  });
  it('travar só vale para runner de projeto', () => {
    expect(ok({ ...base, locked: true })).toBe(false);
    expect(ok({ ...base, target: { type: 'group_type', id: 1 }, locked: true })).toBe(false);
  });
  it('tags: formato e limite', () => {
    expect(ok({ ...base, tags: ['linux', 'gpu:a100', 'x86_64', 'deploy/hml'] })).toBe(true);
    expect(ok({ ...base, tags: ['tag,com,virgula'] })).toBe(false);
    expect(ok({ ...base, tags: ['x'.repeat(51)] })).toBe(false);
    expect(ok({ ...base, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).toBe(false);
  });
  it('timeout: 10 min a 30 dias; descrição ≤ 255; motivo ≥ 10', () => {
    expect(ok({ ...base, maximumTimeout: 599 })).toBe(false);
    expect(ok({ ...base, maximumTimeout: 600 })).toBe(true);
    expect(ok({ ...base, maximumTimeout: 2_592_001 })).toBe(false);
    expect(ok({ ...base, description: 'd'.repeat(256) })).toBe(false);
    expect(ok({ ...base, reason: 'curto' })).toBe(false);
  });
});

describe('demais esquemas e utilitários', () => {
  it('parseTags: separa por vírgula, tira espaços, vazios e repetidas', () => {
    expect(parseTags(' a, b ,,a,c ')).toEqual(['a', 'b', 'c']);
    expect(parseTags('')).toEqual([]);
  });
  it('registrationCommand: docker leva imagem (padrão alpine); shell não', () => {
    const o = { url: 'https://gl.example.com', token: 'glrt-abc' };
    expect(registrationCommand({ ...o, executor: 'docker' })).toBe(
      'gitlab-runner register --non-interactive --url https://gl.example.com --token glrt-abc --executor docker --docker-image alpine:latest',
    );
    expect(registrationCommand({ ...o, executor: 'docker', image: 'node:22' })).toContain('--docker-image node:22');
    expect(registrationCommand({ ...o, executor: 'shell' })).toBe(
      'gitlab-runner register --non-interactive --url https://gl.example.com --token glrt-abc --executor shell',
    );
  });
  it('helmCommands: repositório oficial e instalação idempotente com URL e token', () => {
    const h = helmCommands({ url: 'https://gl.example.com', token: 'glrt-abc' });
    expect(h.repo).toBe('helm repo add gitlab https://charts.gitlab.io && helm repo update');
    expect(h.install).toBe(
      [
        'helm upgrade --install gitlab-runner gitlab/gitlab-runner \\',
        '  --namespace gitlab-runner --create-namespace \\',
        '  --set gitlabUrl=https://gl.example.com \\',
        '  --set runnerToken=glrt-abc \\',
        '  --set rbac.create=true',
      ].join('\n'),
    );
    expect(helmCommands({ url: 'u', token: 't', namespace: 'ci', release: 'r1' }).install).toContain(
      'upgrade --install r1 gitlab/gitlab-runner \\\n  --namespace ci',
    );
  });
  it('remover exige a palavra REMOVER e motivo; pausar exige escopo', () => {
    const scope = { type: 'group_type', id: 3 };
    const del = { runnerId: 1, reason: 'CHG0100 - remoção', confirm: 'REMOVER', scope };
    expect(deleteRunnerSchema.safeParse(del).success).toBe(true);
    expect(deleteRunnerSchema.safeParse({ ...del, confirm: 'remover' }).success).toBe(false);
    expect(deleteRunnerSchema.safeParse({ ...del, reason: 'x' }).success).toBe(false);
    expect(setRunnerPausedSchema.safeParse({ runnerId: 1, paused: true, scope }).success).toBe(true);
    expect(setRunnerPausedSchema.safeParse({ runnerId: 1, paused: true }).success).toBe(false);
    expect(runnerTargetSchema.safeParse({ type: 'instance_type' }).success).toBe(true);
    expect(searchTargetsSchema.safeParse({ kind: 'group', q: 'abc' }).success).toBe(true);
    expect(searchTargetsSchema.safeParse({ kind: 'x', q: '' }).success).toBe(false);
  });
});
