// Cria o PRIMEIRO admin da ferramenta (docs/03-autenticacao.md §6).
//   npm run create-admin                       (lê SEED_ADMIN_* do ambiente/.env)
//   docker compose --profile tools run --rm create-admin
// Recusa rodar se já existir um admin ativo. Imprime a senha temporária uma única vez.
import { auth } from '@/server/auth/auth';
import { generateTempPassword } from '@/server/auth/temp-password';
import { prisma } from '@/server/db';
import { USERNAME_RE } from '@/server/services/tool-user.service';
import { recordAuditSafe } from '@/server/services/audit.service';

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Defina ${name}. Ex.: SEED_ADMIN_USERNAME=admin SEED_ADMIN_NAME="Fulano" SEED_ADMIN_EMAIL=fulano@empresa.com`);
    process.exit(2);
  }
  return v;
}

const username = required('SEED_ADMIN_USERNAME').toLowerCase();
const name = required('SEED_ADMIN_NAME');
const email = required('SEED_ADMIN_EMAIL').toLowerCase();

if (!USERNAME_RE.test(username)) {
  console.error('SEED_ADMIN_USERNAME inválido: 3–32 caracteres entre a-z, 0-9, ponto, hífen e sublinhado.');
  process.exit(2);
}
if ((await prisma.user.count({ where: { role: 'admin', banned: { not: true } } })) > 0) {
  console.error('Já existe um admin ativo. Use a tela "Contas da ferramenta" para criar novos admins.');
  process.exit(1);
}

const password = generateTempPassword();
// Sem headers/request: o plugin `admin` permite a criação server-side (só vale aqui, fora do HTTP).
const { user } = await auth.api.createUser({
  body: { email, password, name, role: 'admin', data: { username, displayUsername: username } },
});
await recordAuditSafe({
  action: 'TOOL_USER_CREATED',
  result: 'SUCCESS',
  actor: { username: 'create-admin-script' },
  target: { type: 'tool_user', id: user.id, label: username },
  reason: 'Seed do primeiro administrador',
  metadata: { role: 'admin' },
});

console.log(
  `\nAdmin criado: ${username}\nSenha temporária (troque no 1º acesso, anote agora — não será exibida de novo):\n\n  ${password}\n`,
);
await prisma.$disconnect();
