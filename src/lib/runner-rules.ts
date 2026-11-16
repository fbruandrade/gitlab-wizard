// Regras dos runners (docs/14). PURO e client-safe.
import { z } from 'zod';
import { reasonSchema } from './schemas';

export const RUNNER_TYPES = ['instance_type', 'group_type', 'project_type'] as const;
export type RunnerType = (typeof RUNNER_TYPES)[number];

export const RUNNER_TYPE_LABEL: Record<RunnerType, string> = {
  instance_type: 'Global (compartilhado da instância)',
  group_type: 'De grupo',
  project_type: 'De projeto',
};

/** GitLab: tempo máximo de job entre 10 min e 30 dias (em segundos). */
export const RUNNER_TIMEOUT = { min: 600, max: 2_592_000 } as const;
export const RUNNER_TAG = /^[\w.:/+@ -]{1,50}$/;

export const runnerTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('instance_type') }),
  z.object({ type: z.literal('group_type'), id: z.number().int().positive() }),
  z.object({ type: z.literal('project_type'), id: z.number().int().positive() }),
]);

export const createRunnerSchema = z
  .object({
    target: runnerTargetSchema,
    description: z.string().trim().max(255).optional(),
    tags: z.array(z.string().trim().regex(RUNNER_TAG, 'Tag inválida (até 50 caracteres: letras, números e . _ - : / + @).')).max(20),
    runUntagged: z.boolean(),
    /** Só faz sentido para runner de projeto. */
    locked: z.boolean(),
    /** Só executa jobs de branches/tags protegidos (`ref_protected`). */
    protectedRefs: z.boolean(),
    paused: z.boolean(),
    maximumTimeout: z.number().int().min(RUNNER_TIMEOUT.min).max(RUNNER_TIMEOUT.max).nullable(),
    reason: reasonSchema,
  })
  .refine((v) => v.tags.length > 0 || v.runUntagged, { path: ['tags'], message: 'Informe ao menos uma tag ou permita jobs sem tag.' })
  .refine((v) => !v.locked || v.target.type === 'project_type', { path: ['locked'], message: 'Travar só vale para runner de projeto.' });
export type CreateRunnerInput = z.infer<typeof createRunnerSchema>;

export const runnerScopeSchema = runnerTargetSchema;
export const runnerIdSchema = z.object({ runnerId: z.number().int().positive() });
export const setRunnerPausedSchema = runnerIdSchema.extend({
  paused: z.boolean(),
  scope: runnerTargetSchema,
});
export const deleteRunnerSchema = runnerIdSchema.extend({
  reason: reasonSchema,
  confirm: z.literal('REMOVER'),
  scope: runnerTargetSchema,
});
export const updateRunnerTagsSchema = runnerIdSchema.extend({
  tags: z.array(z.string().trim().regex(RUNNER_TAG, 'Tag inválida (até 50 caracteres: letras, números e . _ - : / + @).')).max(20),
  reason: reasonSchema,
  scope: runnerTargetSchema,
});
/** O que muda ao trocar as tags (para o resumo antes de confirmar). */
export function diffTags(before: readonly string[], after: readonly string[]) {
  return { added: after.filter((t) => !before.includes(t)), removed: before.filter((t) => !after.includes(t)) };
}
export const searchTargetsSchema = z.object({ kind: z.enum(['group', 'project']), q: z.string().trim().max(100) });

/** Comando para registrar o runner na máquina (o token só existe nesta resposta). */
export function registrationCommand(o: { url: string; token: string; executor: 'docker' | 'shell'; image?: string }): string {
  const base = `gitlab-runner register --non-interactive --url ${o.url} --token ${o.token} --executor ${o.executor}`;
  return o.executor === 'docker' ? `${base} --docker-image ${o.image ?? 'alpine:latest'}` : base;
}

/**
 * Instalação no Kubernetes pelo chart oficial do GitLab Runner. `upgrade --install` repete sem erro; o executor do chart
 * já é `kubernetes`. As tags/opções do runner foram definidas na criação (não vão no helm).
 */
export function helmCommands(o: { url: string; token: string; namespace?: string; release?: string }): { repo: string; install: string } {
  const ns = o.namespace ?? 'gitlab-runner';
  return {
    repo: 'helm repo add gitlab https://charts.gitlab.io && helm repo update',
    install: [
      `helm upgrade --install ${o.release ?? 'gitlab-runner'} gitlab/gitlab-runner`,
      `  --namespace ${ns} --create-namespace`,
      `  --set gitlabUrl=${o.url}`,
      `  --set runnerToken=${o.token}`,
      `  --set rbac.create=true`,
    ].join(' \\\n'),
  };
}

export const parseTags = (s: string) => [
  ...new Set(
    s
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  ),
];

export const DELETE_RUNNER_WORD = 'REMOVER';
