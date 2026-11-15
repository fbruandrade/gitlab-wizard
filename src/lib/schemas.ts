import { z } from 'zod';
import { passwordPolicyIssues } from './password-policy';

// Schemas compartilhados: o formulário valida para dar feedback imediato e o servidor valida de novo (fonte de verdade).

export const loginSchema = z.object({
  username: z.string().trim().min(3, 'Informe o usuário').max(32),
  password: z.string().min(1, 'Informe a senha').max(128),
});

export const newPasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Informe a senha atual'),
    newPassword: z.string().superRefine((v, ctx) => {
      if (passwordPolicyIssues(v).length) ctx.addIssue({ code: 'custom', message: 'A senha não atende à política.' });
    }),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, { path: ['confirmPassword'], message: 'As senhas não conferem.' })
  .refine((v) => v.newPassword !== v.currentPassword, { path: ['newPassword'], message: 'A nova senha deve ser diferente da atual.' });

export const reasonSchema = z.string().trim().min(10, 'Informe o motivo / nº do chamado (mín. 10 caracteres).').max(500);

export const gitlabTokenSchema = z.object({
  token: z.string().trim().min(20, 'Token muito curto.').max(255, 'Token muito longo.'),
});

export const addTokenSchema = gitlabTokenSchema.extend({ makeDefault: z.boolean().default(false) });
export const tokenRefSchema = z.object({ tokenId: z.uuid() });
export const replaceTokenSchema = tokenRefSchema.extend({ token: gitlabTokenSchema.shape.token });

export const gitlabUserActionSchema = z.object({
  gitlabUserId: z.number().int().positive(),
  reason: reasonSchema,
  confirmUsername: z.string().trim().min(1, 'Digite o username para confirmar.'),
});

export const rotateSchema = z.object({
  tokenId: z.uuid().optional(), // sem id: rotaciona o token em uso
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe uma data válida.'),
  reveal: z.boolean().default(false),
});

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,32}$/, '3–32 caracteres: a-z, 0-9, ponto, hífen, sublinhado.');
export const createToolUserSchema = z.object({
  username,
  name: z.string().trim().min(2, 'Informe o nome.').max(100),
  email: z.email('E-mail inválido.'),
  role: z.enum(['user', 'admin']),
  reason: reasonSchema,
});
export const toolUserTargetSchema = z.object({ userId: z.string().min(1), reason: reasonSchema });
export const setRoleSchema = toolUserTargetSchema.extend({ role: z.enum(['user', 'admin']) });
