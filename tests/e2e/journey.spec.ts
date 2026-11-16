import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { control, NEW_PASSWORD, OPERATOR_PASSWORD, sql, state, totp } from './helpers';

test.describe.configure({ mode: 'serial' });

// Contas e segredos que atravessam o roteiro.
let admin: { ctx: BrowserContext; page: Page; totpSecret: string; backupCodes: string[] };
let operator: { ctx: BrowserContext; page: Page; totpSecret: string };
let newAdminPat = '';
const problems: string[] = [];

// Cada chamada simula um cliente com IP novo (balde de rate limit novo), como usuários distintos atrás do proxy.
let ipCounter = 10;
const newIp = async (ctx: BrowserContext) => ctx.setExtraHTTPHeaders({ 'x-forwarded-for': `10.20.0.${++ipCounter}` });

const watch = (page: Page, who: string) => {
  // 401/403 esperados em testes negativos aparecem como "Failed to load resource": não são erros da app.
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`[${who}] console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${who}] pageerror: ${e.message}`));
};

// O Next injeta um role="alert" vazio (route announcer): só interessam os alertas com texto.
const alertOf = (p: Page) => p.getByRole('alert').filter({ hasText: /\S/ });

async function login(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Usuário').fill(username);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

/** Troca da senha temporária (gate obrigatório). */
async function changeInitialPassword(page: Page, current: string, next: string) {
  await expect(page).toHaveURL(/\/account\/change-password/);
  await page.getByLabel('Senha atual').fill(current);
  await page.getByLabel('Nova senha', { exact: true }).fill(next);
  await page.getByLabel('Confirmar nova senha').fill(next);
  await page.getByRole('button', { name: 'Trocar senha' }).click();
}

/** Setup obrigatório do 2FA: devolve a chave TOTP e os códigos de backup. */
async function setupTwoFactor(page: Page, password: string) {
  await expect(page).toHaveURL(/\/setup-2fa/);
  await page.getByLabel('Confirme sua senha').fill(password);
  await page.getByRole('button', { name: 'Ativar 2FA' }).click();
  await expect(page.getByTestId('totp-qr')).toBeVisible();
  const secret = (await page.getByTestId('totp-secret').textContent())!.trim();
  await page.getByLabel('Código de verificação').fill(totp(secret));
  await page.getByRole('button', { name: 'Confirmar e ativar' }).click();
  const dialog = page.getByTestId('secret-dialog');
  await expect(dialog).toBeVisible();
  const backupCodes = (await page.getByTestId('secret-value').textContent())!.trim().split('\n');
  await dialog.getByRole('button', { name: 'Já guardei, fechar' }).click();
  return { secret, backupCodes };
}

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  watch(page, 'admin');
  admin = { ctx, page, totpSecret: '', backupCodes: [] };
  await newIp(ctx);
});
test.afterAll(async () => {
  await admin?.ctx.close();
  await operator?.ctx.close();
});

test.describe('acesso à ferramenta', () => {
  test('sem sessão, qualquer página vai para o login; CSP com nonce e headers de segurança', async () => {
    const res = await admin.page.goto('/token');
    await expect(admin.page).toHaveURL(/\/login$/);
    const h = res!.headers();
    expect(h['content-security-policy']).toMatch(/script-src 'self' 'nonce-[\w+/=]+' 'strict-dynamic'/);
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
  });

  test('credenciais inválidas: mensagem genérica, igual para usuário inexistente', async () => {
    await login(admin.page, 'admin', 'Errada!Senha#123');
    await expect(alertOf(admin.page)).toContainText('Usuário ou senha inválidos.');
    const first = await alertOf(admin.page).textContent();
    await login(admin.page, 'fantasma', 'Errada!Senha#123');
    await expect(alertOf(admin.page)).toContainText('Usuário ou senha inválidos.');
    expect(await alertOf(admin.page).textContent()).toBe(first);
  });

  test('primeiro acesso do admin: troca de senha obrigatória (com política) e setup do 2FA', async () => {
    await login(admin.page, 'admin', state().adminPassword);
    await expect(admin.page).toHaveURL(/\/account\/change-password/);

    // rota protegida pelo gate: não dá para pular a troca
    await admin.page.goto('/token');
    await expect(admin.page).toHaveURL(/\/account\/change-password/);

    await admin.page.getByLabel('Senha atual').fill(state().adminPassword);
    await admin.page.getByLabel('Nova senha', { exact: true }).fill('curta');
    await admin.page.getByLabel('Confirmar nova senha').fill('curta');
    await admin.page.getByRole('button', { name: 'Trocar senha' }).click();
    await expect(admin.page.getByText('A senha não atende à política.')).toBeVisible();

    await changeInitialPassword(admin.page, state().adminPassword, NEW_PASSWORD);
    const { secret, backupCodes } = await setupTwoFactor(admin.page, NEW_PASSWORD);
    admin.totpSecret = secret;
    admin.backupCodes = backupCodes;
    expect(backupCodes).toHaveLength(10);

    await expect(admin.page.getByRole('heading', { name: /Olá, Administrador E2E/ })).toBeVisible();
    await expect(admin.page.getByTestId('no-token-card')).toBeVisible();
  });

  test('logout, e novo login exige o código do 2FA (inválido é recusado)', async () => {
    await newIp(admin.ctx);
    await admin.page.getByRole('button', { name: 'Sair' }).click();
    await expect(admin.page).toHaveURL(/\/login$/);
    await admin.page.goto('/token');
    await expect(admin.page).toHaveURL(/\/login$/); // sessão realmente encerrada

    await login(admin.page, 'admin', NEW_PASSWORD);
    await expect(admin.page).toHaveURL(/\/login\/2fa/);
    await admin.page.getByLabel('Código de 6 dígitos').fill('000000');
    await expect(alertOf(admin.page)).toContainText('Código inválido.');
    await admin.page.getByLabel('Código de 6 dígitos').fill(totp(admin.totpSecret));
    await expect(admin.page.getByRole('heading', { name: /Olá,/ })).toBeVisible();
  });
});

test.describe('token GitLab (certificado auto-assinado)', () => {
  test('vincula o PAT e o app fala com o GitLab HTTPS auto-assinado', async () => {
    await admin.page.goto('/token');
    await admin.page.getByLabel('Personal Access Token do GitLab').fill('glpat-invalido-0000000000');
    await admin.page.getByRole('button', { name: 'Vincular token' }).click();
    await expect(alertOf(admin.page)).toContainText('inválido');

    await admin.page.getByLabel('Personal Access Token do GitLab').fill(state().adminPat);
    await admin.page.getByRole('button', { name: 'Vincular token' }).click();
    await expect(admin.page.getByTestId('token-card')).toContainText('@root');

    await expect(admin.page.getByTestId('gitlab-badge')).toHaveText('@root (admin)');
    // aviso permanente: GITLAB_TLS_INSECURE=true
    await expect(admin.page.getByText('TLS do GitLab sem verificação')).toBeVisible();
    // este PAT vence em 5 dias → banner
    await expect(admin.page.getByTestId('expiry-banner')).toBeVisible();
  });

  test('dashboard mostra as capacidades do token', async () => {
    await admin.page.goto('/');
    for (const c of ['READ_USERS', 'ADMIN_USERS', 'SELF_ROTATE'])
      await expect(admin.page.getByTestId(`cap-${c}`)).toHaveAttribute('data-ok', 'true');
  });

  test('o PAT fica cifrado no banco (nunca em claro)', async () => {
    const rows = await sql<Record<string, unknown>>('SELECT * FROM gitlab_token');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(state().adminPat);
    const audit = await sql('SELECT * FROM audit_log');
    expect(JSON.stringify(audit)).not.toContain(state().adminPat);
  });
});

test.describe('usuários GitLab', () => {
  test('mostra a licença: Users in subscription / Maximum Users / Billable users / Users over License', async () => {
    await admin.page.goto('/gitlab/users');
    const box = admin.page.getByTestId('license-summary');
    await expect(box).toContainText('Users in subscription');
    await expect(box).toContainText('Maximum Users');
    await expect(box).toContainText('Billable users');
    await expect(box).toContainText('Users over License');
    await expect(admin.page.getByTestId('license-user_limit')).toHaveText('100');
    await expect(admin.page.getByTestId('license-maximum_user_count')).toHaveText('130');
    await expect(admin.page.getByTestId('license-active_users')).toHaveText('120');
    await expect(admin.page.getByTestId('license-overage')).toHaveText('20');
    await expect(admin.page.getByTestId('license-overage')).toHaveAttribute('data-over', 'true'); // acima da licença → destaque
    await expect(box).toContainText('premium');

    // sem licença (Community): aviso discreto e a busca continua funcionando
    await control.post('/license', { clear: true });
    await admin.page.goto('/gitlab/users?q=maria');
    await expect(admin.page.getByTestId('license-unavailable')).toContainText('não tem licença');
    await expect(admin.page.getByTestId('users-table')).toContainText('maria');
    await control.post('/license', {
      plan: 'premium',
      expires_at: '2027-06-30',
      expired: false,
      user_limit: 100,
      maximum_user_count: 130,
      active_users: 120,
      overage: 20,
    });
  });

  test('busca, paginação e filtro de bloqueados', async () => {
    await admin.page.goto('/gitlab/users?q=extra');
    await expect(admin.page.getByTestId('users-table').getByRole('row')).toHaveCount(21); // cabeçalho + 20
    await admin.page.getByRole('link', { name: 'Próxima ›' }).click();
    await expect(admin.page.getByTestId('users-table').getByRole('row')).toHaveCount(6); // cabeçalho + 5
    await admin.page.goto('/gitlab/users?q=zzzz-nao-existe');
    await expect(admin.page.getByTestId('users-empty')).toBeVisible();
    await admin.page.goto('/gitlab/users?blocked=1');
    await expect(admin.page.getByTestId('users-table')).toContainText('joao');
    await expect(admin.page.getByTestId('users-table')).not.toContainText('maria');
  });

  test('desbloquear: botão só habilita com motivo + username; efetiva no GitLab e audita', async () => {
    await admin.page.goto('/gitlab/users?q=joao');
    await admin.page.getByRole('link', { name: 'joao' }).click();
    await expect(admin.page.getByTestId('state-badge')).toHaveAttribute('data-state', 'blocked');

    await admin.page.getByTestId('unblock-open').click();
    const confirm = admin.page.getByTestId('unblock-confirm');
    await expect(confirm).toBeDisabled();
    await admin.page.getByLabel('Motivo / nº do chamado *').fill('INC0012345 - bloqueado por engano');
    await admin.page.getByLabel(/Digite "joao"/).fill('outro');
    await expect(confirm).toBeDisabled();
    await admin.page.getByLabel(/Digite "joao"/).fill('joao');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(admin.page.getByTestId('state-badge')).toHaveAttribute('data-state', 'active');
    const joao = await control.get<{ state: string }>('/users?username=joao');
    expect(joao.state).toBe('active');
    const [a] = await sql<{ result: string; reason: string; actor_username: string }>(
      "SELECT result, reason, actor_username FROM audit_log WHERE action='GITLAB_USER_UNBLOCKED'",
    );
    expect(a).toMatchObject({ result: 'SUCCESS', reason: 'INC0012345 - bloqueado por engano', actor_username: 'admin' });
  });

  test('bloquear: pede motivo + username (aviso extra para admin GitLab), efetiva no GitLab; a própria conta não pode ser bloqueada', async () => {
    const ana = await control.post<{ id: number }>('/users', { username: 'ana', name: 'Ana Ativa' });
    await admin.page.goto(`/gitlab/users/${ana.id}`);
    await expect(admin.page.getByTestId('state-badge')).toHaveAttribute('data-state', 'active');
    await admin.page.getByTestId('block-open').click();
    const confirm = admin.page.getByTestId('block-confirm');
    await expect(confirm).toBeDisabled();
    await admin.page.getByLabel('Motivo / nº do chamado *').fill('INC0077777 - conta comprometida');
    await admin.page.getByLabel(/Digite "ana"/).fill('ana');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(admin.page.getByTestId('state-badge')).toHaveAttribute('data-state', 'blocked');
    expect((await control.get<{ state: string }>('/users?username=ana')).state).toBe('blocked');
    await expect(admin.page.getByTestId('block-na')).toContainText('já está bloqueado');
    // volta ao normal pela própria tela
    await admin.page.getByTestId('unblock-open').click();
    await admin.page.getByLabel('Motivo / nº do chamado *').fill('INC0077778 - falso positivo');
    await admin.page.getByLabel(/Digite "ana"/).fill('ana');
    await admin.page.getByTestId('unblock-confirm').click();
    await expect(admin.page.getByTestId('state-badge')).toHaveAttribute('data-state', 'active');

    // a conta GitLab do próprio operador (root): sem botão de bloquear
    const root = await control.get<{ id: number }>('/users?username=root');
    await admin.page.goto(`/gitlab/users/${root.id}`);
    await expect(admin.page.getByTestId('block-na')).toContainText('não pode bloquear a própria conta');
    await expect(admin.page.getByTestId('block-open')).toHaveCount(0);
    const [a] = await sql<{ result: string }>("SELECT result FROM audit_log WHERE action='GITLAB_USER_BLOCKED' AND target_label='ana'");
    expect(a?.result).toBe('SUCCESS');
  });

  test('ldap_blocked não oferece desbloqueio', async () => {
    await admin.page.goto('/gitlab/users?q=pedro');
    await admin.page.getByRole('link', { name: 'pedro' }).click();
    await expect(admin.page.getByTestId('unblock-na')).toContainText('LDAP');
    await expect(admin.page.getByTestId('unblock-open')).toHaveCount(0);
  });

  test('resetar MFA exige a confirmação de identidade e efetiva no GitLab', async () => {
    await admin.page.goto('/gitlab/users?q=maria');
    await admin.page.getByRole('link', { name: 'maria' }).click();
    await expect(admin.page.getByTestId('user-mfa')).toHaveText('habilitado');
    await admin.page.getByTestId('disable2fa-open').click();
    await admin.page.getByLabel('Motivo / nº do chamado *').fill('INC0099999 - perdeu o celular');
    await admin.page.getByLabel(/Digite "maria"/).fill('maria');
    await expect(admin.page.getByTestId('disable2fa-confirm')).toBeDisabled(); // falta o checkbox
    await admin.page.getByRole('checkbox', { name: /Confirmei a identidade/ }).click();
    await admin.page.getByTestId('disable2fa-confirm').click();
    await expect(admin.page.getByTestId('user-mfa')).toHaveText('não habilitado');
    expect((await control.get<{ two_factor_enabled: boolean }>('/users?username=maria')).two_factor_enabled).toBe(false);
  });

  test('resetar MFA de ADMINISTRADOR GitLab: sem botão, com a explicação da regra do GitLab', async () => {
    const root = await control.get<{ id: number }>('/users?username=root');
    await admin.page.goto(`/gitlab/users/${root.id}`); // admin (e a própria conta)
    await expect(admin.page.getByTestId('disable2fa-na')).toContainText('não permite resetar o MFA de administradores');
    await admin.page.getByText('Passo a passo pelo console Rails').click(); // abre o <details>
    const cmd = admin.page.getByTestId('mfa-console-command');
    await expect(cmd).toContainText("admin = User.find_by_username('root')");
    await expect(cmd).toContainText("alvo  = User.find_by_username('root')");
    await expect(cmd).toContainText('TwoFactor::DestroyService.new(admin, user: alvo).execute');
    await expect(admin.page.getByTestId('mfa-console-guide')).toContainText('sudo gitlab-rails console');
    await expect(admin.page.getByTestId('disable2fa-open')).toHaveCount(0);
  });

  test('login velho (>15 min) → pede reautenticação (senha + TOTP) e repete a ação', async () => {
    await newIp(admin.ctx);
    await control.post('/users', { username: 'carlos', name: 'Carlos Bloqueado', state: 'blocked' });
    await sql(`UPDATE session SET "createdAt" = now() - interval '20 minutes'`);
    await admin.page.goto('/gitlab/users?q=carlos');
    await admin.page.getByRole('link', { name: 'carlos' }).click();
    await admin.page.getByTestId('unblock-open').click();
    await admin.page.getByLabel('Motivo / nº do chamado *').fill('INC0055555 - reautenticação');
    await admin.page.getByLabel(/Digite "carlos"/).fill('carlos');
    await admin.page.getByTestId('unblock-confirm').click();

    const reauth = admin.page.getByTestId('reauth-dialog');
    await expect(reauth).toBeVisible();
    await reauth.getByLabel(/Senha de admin/).fill(NEW_PASSWORD);
    await reauth.getByRole('button', { name: 'Continuar' }).click();
    await reauth.getByLabel('Código do autenticador').fill(totp(admin.totpSecret));
    await reauth.getByRole('button', { name: 'Continuar' }).click();

    await expect(admin.page.getByTestId('state-badge')).toHaveAttribute('data-state', 'active');
    expect((await control.get<{ state: string }>('/users?username=carlos')).state).toBe('active');
  });
});

test.describe('rotação do token', () => {
  test('rotaciona, mostra o novo token uma vez, salva e continua funcionando; o antigo é revogado', async () => {
    await admin.page.goto('/token');
    await admin.page.getByRole('checkbox', { name: /Quero visualizar o novo token/ }).click();
    await admin.page.getByRole('button', { name: 'Rotacionar agora' }).click();
    await expect(admin.page.getByText('O token atual será revogado imediatamente')).toBeVisible();
    await admin.page.getByTestId('confirm-rotate').click();

    const dialog = admin.page.getByTestId('secret-dialog');
    await expect(dialog).toBeVisible();
    newAdminPat = (await admin.page.getByTestId('secret-value').textContent())!.trim();
    expect(newAdminPat).toMatch(/^glpat-/);
    expect(newAdminPat).not.toBe(state().adminPat);
    await dialog.getByRole('button', { name: 'Já guardei, fechar' }).click();
    await expect(dialog).toBeHidden();

    // GitLab: antigo morto, novo vivo
    expect((await control.get<{ revoked: boolean }>(`/tokens/${state().adminPat}`)).revoked).toBe(true);
    expect((await control.get<{ revoked: boolean }>(`/tokens/${newAdminPat}`)).revoked).toBe(false);

    // o token novo nunca é exibido de novo e não está em claro no banco/auditoria/HTML
    await admin.page.reload();
    expect(await admin.page.content()).not.toContain(newAdminPat);
    expect(JSON.stringify(await sql('SELECT * FROM gitlab_token'))).not.toContain(newAdminPat);
    expect(JSON.stringify(await sql('SELECT * FROM audit_log'))).not.toContain(newAdminPat);

    // a ferramenta segue operando sem recadastro, agora com o token novo; histórico e banner
    await expect(admin.page.getByTestId('expiry-banner')).toHaveCount(0);
    await expect(admin.page.getByTestId('token-history')).toContainText('ROTATED');
    await admin.page.goto('/gitlab/users?q=maria');
    await expect(admin.page.getByTestId('users-table')).toContainText('maria');

    // propriedade crítica: depois do POST /rotate, nada usa o token antigo
    const reqs = await control.get<{ path: string; token: string }[]>('/requests');
    const idx = reqs.findIndex((r) => r.path.endsWith('/rotate'));
    expect(idx).toBeGreaterThan(-1);
    expect(reqs.slice(idx + 1).some((r) => r.token === state().adminPat)).toBe(false);
    expect(reqs.slice(idx + 1).some((r) => r.token === newAdminPat)).toBe(true);
  });

  test('substituir token: de outro usuário GitLab é recusado; do mesmo, aceito', async () => {
    await admin.page.goto('/token');
    await admin.page.getByTestId('open-replace').click();
    await admin.page.getByLabel('Novo Personal Access Token').fill(state().rotateOnlyPat);
    await admin.page.getByRole('button', { name: 'Substituir token' }).click();
    await expect(alertOf(admin.page)).toContainText('pertence a outro usuário GitLab');

    const second = await control.post<{ token: string }>('/tokens', { userId: 100, scopes: ['api', 'admin_mode'], name: 'wizard-admin-2' });
    await admin.page.getByLabel('Novo Personal Access Token').fill(second.token);
    await admin.page.getByRole('button', { name: 'Substituir token' }).click();
    await expect(admin.page.getByTestId('token-history')).toContainText('REPLACED');
    newAdminPat = second.token;
  });
});

test.describe('vários tokens: escopos, padrão e token em uso', () => {
  const cards = () => admin.page.getByTestId('token-card');
  const card = (name: string) => cards().filter({ has: admin.page.getByTestId('token-name').filter({ hasText: new RegExp(`^${name}$`) }) });
  const original = 'wizard-admin-2'; // o token vinculado nos testes anteriores (padrão)
  let leitura: { token: string };
  let rotacao: { token: string };
  let rootId: number;

  async function addByUi(token: string, makeDefault = false) {
    await admin.page.getByLabel('Personal Access Token do GitLab').fill(token);
    if (makeDefault) await admin.page.getByRole('checkbox', { name: /Definir este como o token padrão/ }).click();
    await admin.page.getByTestId('add-token').click();
  }

  test('adiciona mais tokens; cada um mostra os SEUS escopos e o que permite; o primeiro segue padrão', async () => {
    rootId = (await control.get<{ id: number }>('/users?username=root')).id;
    leitura = await control.post('/tokens', { userId: rootId, name: 'leitura', scopes: ['read_api'] });
    rotacao = await control.post('/tokens', { userId: rootId, name: 'rotacao', scopes: ['self_rotate', 'read_user'] });

    await admin.page.goto('/token');
    await expect(cards()).toHaveCount(1);
    await addByUi(leitura.token);
    await expect(cards()).toHaveCount(2);

    // o padrão não mudou; os escopos de cada token aparecem inteiros
    await expect(card(original).getByTestId('badge-default')).toBeVisible();
    await expect(card('leitura').getByTestId('badge-default')).toHaveCount(0);
    await expect(card('leitura').getByTestId('scope-list')).toContainText('read_api');
    await expect(card(original).getByTestId('scope-list')).toContainText('api');
    await expect(card(original).getByTestId('scope-list')).toContainText('admin_mode');
    // ... e o que cada um permite
    await expect(card('leitura').getByTestId('tcap-READ_USERS')).toHaveAttribute('data-ok', 'true');
    await expect(card('leitura').getByTestId('tcap-ADMIN_USERS')).toHaveAttribute('data-ok', 'false');
    await expect(card('leitura').getByTestId('tcap-SELF_ROTATE')).toHaveAttribute('data-ok', 'false');
    await expect(card(original).getByTestId('tcap-ADMIN_USERS')).toHaveAttribute('data-ok', 'true');
    // com 2+ tokens o cabeçalho passa a ter o seletor
    await expect(admin.page.getByTestId('token-switcher')).toBeVisible();
  });

  test('adicionar marcando "padrão" muda o padrão; o mesmo token não entra duas vezes; só um padrão por vez', async () => {
    await addByUi(rotacao.token, true);
    await expect(cards()).toHaveCount(3);
    await expect(card('rotacao').getByTestId('badge-default')).toBeVisible();
    await expect(card(original).getByTestId('badge-default')).toHaveCount(0);
    await expect(admin.page.locator('[data-testid=token-card][data-default=true]')).toHaveCount(1);

    await addByUi(rotacao.token); // de novo
    await expect(alertOf(admin.page)).toContainText('já está cadastrado');
    await expect(cards()).toHaveCount(3);

    // volta o padrão para o original
    await card(original).getByTestId('set-default').click();
    await expect(card(original).getByTestId('badge-default')).toBeVisible();
    await expect(admin.page.locator('[data-testid=token-card][data-default=true]')).toHaveCount(1);
  });

  test('trocar o token EM USO pelo cabeçalho muda o que a ferramenta permite, sem mexer no padrão', async () => {
    await admin.page.goto('/token');
    const leituraGitlabId = await card('leitura').getAttribute('data-token-id');
    const originalGitlabId = await card(original).getAttribute('data-token-id');
    await admin.page.getByTestId('token-switcher').click();
    await admin.page.getByTestId(`switch-${leituraGitlabId}`).click();

    await expect(card('leitura').getByTestId('badge-in-use')).toBeVisible();
    await expect(card(original).getByTestId('badge-in-use')).toHaveCount(0);
    await expect(card(original).getByTestId('badge-default')).toBeVisible(); // o padrão continua o original
    await expect(admin.page.getByTestId('gitlab-badge')).toContainText('leitura');

    // com o token de LEITURA: dá para ver usuários, mas não há ações de escrita (e a tela explica)
    await admin.page.goto('/');
    await expect(admin.page.getByTestId('cap-READ_USERS')).toHaveAttribute('data-ok', 'true');
    await expect(admin.page.getByTestId('cap-ADMIN_USERS')).toHaveAttribute('data-ok', 'false');
    const maria = await control.get<{ id: number }>('/users?username=maria');
    await admin.page.goto(`/gitlab/users/${maria.id}`);
    await expect(admin.page.getByText('Seu token não permite ações neste usuário')).toBeVisible();
    await expect(admin.page.getByTestId('block-open')).toHaveCount(0);
    // e a requisição saiu com o PAT do token de leitura
    const reqs = await control.get<{ path: string; token: string }[]>('/requests');
    expect(reqs.some((r) => r.token === leitura.token && r.path.startsWith('/users/'))).toBe(true);

    // volta ao original pelo cabeçalho: as ações reaparecem
    await admin.page.getByTestId('token-switcher').click();
    await admin.page.getByTestId(`switch-${originalGitlabId}`).click();
    await expect(admin.page.getByTestId('block-open')).toBeVisible();
    await expect(admin.page.getByTestId('gitlab-badge')).toContainText(original);
  });

  test('o token escolhido vale por navegador e um valor inválido/forjado no cookie é ignorado (cai no padrão)', async () => {
    // garante o original em uso; depois força um cookie com um id que não é de nenhum token desta conta
    await admin.page.goto('/token');
    await admin.ctx.addCookies([{ name: 'gw.active_token', value: crypto.randomUUID(), url: state().appUrl }]);
    await admin.page.reload();
    await expect(card(original).getByTestId('badge-in-use')).toBeVisible(); // caiu no padrão
    await expect(admin.page.locator('[data-testid=token-card][data-in-use=true]')).toHaveCount(1);
    await admin.ctx.addCookies([{ name: 'gw.active_token', value: 'isto-nao-e-um-uuid', url: state().appUrl }]);
    await admin.page.goto('/gitlab/users?q=maria');
    await expect(admin.page.getByTestId('users-table')).toContainText('maria'); // a ferramenta segue funcionando
  });

  test('definir como padrão persiste (recarregar) e é único', async () => {
    await admin.page.goto('/token');
    await card('leitura').getByTestId('set-default').click();
    await expect(card('leitura').getByTestId('badge-default')).toBeVisible();
    await admin.page.reload();
    await expect(card('leitura').getByTestId('badge-default')).toBeVisible();
    await expect(admin.page.locator('[data-testid=token-card][data-default=true]')).toHaveCount(1);
    const [a] = await sql<{ metadata: { from: string; to: string } }>(
      "SELECT metadata FROM audit_log WHERE action='GITLAB_TOKEN_DEFAULT_CHANGED' ORDER BY created_at DESC LIMIT 1",
    );
    expect(a?.metadata).toEqual({ from: original, to: 'leitura' });
  });

  test('rotacionar UM token específico não afeta os demais', async () => {
    const before = await control.get<{ revoked: boolean }>(`/tokens/${encodeURIComponent(leitura.token)}`);
    expect(before.revoked).toBe(false);
    const c = card('rotacao');
    await c.getByRole('button', { name: 'Rotacionar agora' }).click();
    await admin.page.getByTestId('confirm-rotate').click();
    // a rotação é assíncrona (Server Action → GitLab): espera concluir em vez de supor que já terminou
    await expect
      .poll(async () => (await control.get<{ revoked: boolean }>(`/tokens/${encodeURIComponent(rotacao.token)}`)).revoked, {
        timeout: 15_000,
      })
      .toBe(true);
    expect((await control.get<{ revoked: boolean }>(`/tokens/${encodeURIComponent(rotacao.token)}`)).revoked).toBe(true); // rotacionado
    expect((await control.get<{ revoked: boolean }>(`/tokens/${encodeURIComponent(leitura.token)}`)).revoked).toBe(false); // intacto
    expect((await control.get<{ revoked: boolean }>(`/tokens/${encodeURIComponent(newAdminPat)}`)).revoked).toBe(false); // intacto
    await expect(cards()).toHaveCount(3); // o novo substituiu o antigo na lista
    await expect(card('leitura').getByTestId('badge-default')).toBeVisible(); // o padrão não mudou
  });

  test('remover o padrão promove outro; ao final fica só o original, sem seletor, e nada foi revogado no GitLab', async () => {
    await card('leitura').getByTestId('unlink-open').click();
    await expect(admin.page.getByText(/não é revogado no GitLab/)).toBeVisible();
    await admin.page.getByTestId('unlink-confirm').click();
    await expect(cards()).toHaveCount(2);
    await expect(admin.page.locator('[data-testid=token-card][data-default=true]')).toHaveCount(1); // alguém assumiu o padrão

    await card('rotacao').getByTestId('unlink-open').click();
    await admin.page.getByTestId('unlink-confirm').click();
    await expect(cards()).toHaveCount(1);
    await expect(card(original).getByTestId('badge-default')).toBeVisible();
    await expect(admin.page.getByTestId('token-switcher')).toHaveCount(0); // volta ao selo simples
    await expect(admin.page.getByTestId('gitlab-badge')).toHaveText('@root (admin)');
    // desvincular NÃO revoga: o PAT de leitura segue válido no GitLab
    expect((await control.get<{ revoked: boolean }>(`/tokens/${encodeURIComponent(leitura.token)}`)).revoked).toBe(false);
    // a ferramenta segue operando com o token original
    await admin.page.goto('/gitlab/users?q=maria');
    await expect(admin.page.getByTestId('users-table')).toContainText('maria');
  });
});

test.describe('limpeza de credenciais', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  let zumbi: { id: number };
  let dormente: { id: number };

  test('o número de dias é configurável na tela e fica salvo como padrão (auditado)', async () => {
    await admin.page.getByRole('link', { name: 'Limpeza de credenciais' }).click();
    await expect(admin.page.getByRole('heading', { name: 'Limpeza de credenciais' })).toBeVisible();
    await expect(admin.page.getByTestId('unused-days')).toHaveValue('90');
    await admin.page.getByTestId('unused-days').fill('60');
    await admin.page.getByTestId('save-days').click();
    await expect(admin.page.getByText('Padrão salvo: 60 dias sem uso.')).toBeVisible();
    await admin.page.reload();
    await expect(admin.page.getByTestId('unused-days')).toHaveValue('60'); // o padrão passou a valer
    const [a] = await sql<{ metadata: { from: number; to: number } }>(
      "SELECT metadata FROM audit_log WHERE action='SETTINGS_CHANGED' ORDER BY created_at DESC LIMIT 1",
    );
    expect(a?.metadata).toMatchObject({ from: 90, to: 60 });
    // volta a 90 para o restante do roteiro
    await admin.page.getByTestId('unused-days').fill('90');
    await admin.page.getByTestId('save-days').click();
    await expect(admin.page.getByText('Padrão salvo: 90 dias sem uso.')).toBeVisible();
  });

  test('critérios e tipos são obrigatórios (botão desabilita)', async () => {
    await admin.page.goto('/admin/cleanup');
    await admin.page.getByTestId('crit-blocked').uncheck();
    await admin.page.getByTestId('crit-unused').uncheck();
    await expect(admin.page.getByTestId('start-scan')).toBeDisabled();
    await admin.page.getByTestId('crit-blocked').check();
    await expect(admin.page.getByTestId('start-scan')).toBeEnabled();
    await admin.page.getByTestId('type-pat').uncheck();
    await admin.page.getByTestId('type-ssh').uncheck();
    await expect(admin.page.getByTestId('start-scan')).toBeDisabled();
  });

  test('varredura (simulação) acha só o que deve, avisa sobre chave sem último uso e NÃO revoga nada', async () => {
    zumbi = await control.post<{ id: number }>('/users', { username: 'zumbi', name: 'Zumbi Bloqueado', state: 'blocked' });
    dormente = await control.post<{ id: number }>('/users', { username: 'dormente', name: 'Dormente Ativo' });
    const vivo = await control.post<{ id: number }>('/users', { username: 'vivo', name: 'Vivo Ativo' });
    const robo = await control.post<{ id: number }>('/users', { username: 'project_9_bot_ci', name: 'Bot CI', bot: true });
    await control.post('/tokens', {
      userId: zumbi.id,
      name: 'tok-zumbi',
      last_used_at: daysAgo(1),
      scopes: ['api', 'read_user', 'read_repository', 'write_repository', 'sudo'],
    });
    await control.post('/tokens', { userId: dormente.id, name: 'tok-dormente', last_used_at: daysAgo(200), created_at: daysAgo(400) });
    await control.post('/tokens', { userId: vivo.id, name: 'tok-vivo', last_used_at: daysAgo(2) });
    await control.post('/tokens', { userId: robo.id, name: 'tok-bot', last_used_at: daysAgo(500) });
    await control.post('/keys', { userId: zumbi.id, title: 'key-zumbi', last_used_at: daysAgo(1), usage_type: 'auth_and_signing' });
    await control.post('/keys', { userId: dormente.id, title: 'key-dormente', last_used_at: daysAgo(200) });
    await control.post('/keys', { userId: vivo.id, title: 'key-sem-campo', created_at: daysAgo(900), omitLastUsed: true });

    await admin.page.goto('/admin/cleanup');
    await admin.page.getByTestId('start-scan').click();
    await expect(admin.page.getByTestId('cleanup-table')).toBeVisible({ timeout: 30_000 });
    const table = admin.page.getByTestId('cleanup-table');
    for (const nome of ['tok-zumbi', 'key-zumbi', 'tok-dormente', 'key-dormente']) await expect(table).toContainText(nome);
    for (const nao of ['tok-vivo', 'key-sem-campo', 'tok-bot']) await expect(table).not.toContainText(nao);
    await expect(admin.page.getByTestId('sum-selectable')).toHaveText('4');

    // coluna de escopos: privilegiados em destaque, o resto compacto (+N), lista completa no tooltip/leitor de tela
    const rowZumbi = admin.page.locator('tr', { hasText: 'tok-zumbi' });
    const scopes = rowZumbi.getByTestId('scopes');
    await expect(scopes).toContainText('api');
    await expect(scopes).toContainText('sudo');
    await expect(scopes).toContainText('+1'); // 5 escopos: 2 privilegiados + 2 exibidos + 1 oculto
    await expect(scopes).toHaveAttribute('title', 'api, read_user, read_repository, write_repository, sudo');
    await expect(scopes).toContainText('Todos os escopos: api, read_user, read_repository, write_repository, sudo');
    await expect(admin.page.getByTestId('sum-privileged')).toContainText('2 token(s) com escopo privilegiado'); // zumbi e dormente (api)
    // chave SSH: sem escopos, mostra o tipo de uso
    await expect(admin.page.locator('tr', { hasText: 'key-zumbi' })).toContainText('autenticação + assinatura');
    await expect(admin.page.getByTestId('ssh-warning')).toContainText('não informou o último uso');
    // dry-run: nada mudou no GitLab
    expect((await control.get<unknown[]>('/keys')).length).toBeGreaterThanOrEqual(3);
  });

  test('revogar: exige motivo + digitar REVOGAR; revoga no GitLab, audita item a item e a lista fica vazia', async () => {
    await admin.page.getByTestId('select-all').check();
    await admin.page.getByTestId('revoke-open').click();
    const confirm = admin.page.getByTestId('revoke-confirm');
    await expect(confirm).toBeDisabled();
    await admin.page.getByLabel('Motivo / nº do chamado *').fill('CHG0042 - higiene trimestral');
    await admin.page.getByLabel(/Digite REVOGAR/).fill('revogar'); // minúsculo não vale
    await expect(confirm).toBeDisabled();
    await admin.page.getByLabel(/Digite REVOGAR/).fill('REVOGAR');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(admin.page.getByTestId('exec-result')).toContainText('4');
    await expect(admin.page.getByTestId('exec-result')).toContainText('revogada(s)');

    const keys = await control.get<{ title: string }[]>('/keys');
    expect(keys.map((k) => k.title)).not.toContain('key-zumbi');
    expect(keys.map((k) => k.title)).not.toContain('key-dormente');
    expect(keys.map((k) => k.title)).toContain('key-sem-campo'); // sem dado de uso, não foi tocada
    const pats = await sql<{ metadata: { name: string }; reason: string; target_label: string }>(
      "SELECT metadata, reason, target_label FROM audit_log WHERE action='GITLAB_CLEANUP_PAT_REVOKED' ORDER BY target_label",
    );
    expect(pats.map((p) => p.target_label)).toEqual(['dormente', 'zumbi']);
    expect(pats.every((p) => p.reason === 'CHG0042 - higiene trimestral')).toBe(true);
    const [sum] = await sql<{ result: string; metadata: { revoked: number } }>(
      "SELECT result, metadata FROM audit_log WHERE action='GITLAB_CLEANUP_EXECUTED'",
    );
    expect(sum).toMatchObject({ result: 'SUCCESS', metadata: { revoked: 4 } });

    // nova varredura: nada a fazer
    await admin.page.goto('/admin/cleanup');
    await admin.page.getByTestId('start-scan').click();
    await expect(admin.page.getByTestId('scan-empty')).toBeVisible({ timeout: 30_000 });
  });

  test('o token do próprio operador (mesmo parado há dias) aparece PROTEGIDO e nunca é revogado', async () => {
    // o PAT que a ferramenta usa passa a ter último uso antigo: seria candidato, mas é a conta do operador
    await control.post(`/tokens/${newAdminPat}/patch`, { last_used_at: daysAgo(30) });
    await admin.page.goto('/admin/cleanup');
    await admin.page.getByTestId('crit-blocked').uncheck();
    await admin.page.getByTestId('unused-days').fill('1'); // "mais de 1 dia"
    await admin.page.getByTestId('start-scan').click();
    await expect(admin.page.getByTestId('cleanup-results')).toBeVisible({ timeout: 30_000 });

    const protectedRows = admin.page.locator('tr[data-protected="true"]');
    await expect(protectedRows).toHaveCount(1);
    await expect(protectedRows).toContainText('Sua própria conta');
    await expect(protectedRows.getByRole('checkbox')).toBeDisabled();

    // "selecionar todos" não inclui o protegido: nada fica selecionado se só há ele
    await admin.page.getByTestId('select-all').check();
    expect(await admin.page.locator('tr[data-protected="false"] input:checked').count()).toBe(
      await admin.page.locator('tr[data-protected="false"]').count(),
    );
    await expect(protectedRows.getByRole('checkbox')).not.toBeChecked();
    expect((await control.get<{ revoked: boolean }>(`/tokens/${newAdminPat}`)).revoked).toBe(false);
    await control.post(`/tokens/${newAdminPat}/patch`, { last_used_at: new Date().toISOString() }); // restaura
  });

  test('chaves SSH sem prazo de validade: lista também a chave sem dado de último uso (dry-run)', async () => {
    await admin.page.goto('/admin/cleanup');
    await admin.page.getByTestId('crit-blocked').uncheck();
    await admin.page.getByTestId('crit-unused').uncheck();
    await expect(admin.page.getByTestId('start-scan')).toBeDisabled();
    await admin.page.getByTestId('crit-noexpiry').check();
    await admin.page.getByTestId('type-pat').uncheck();
    await admin.page.getByTestId('start-scan').click();
    const table = admin.page.getByTestId('cleanup-table');
    await expect(table).toBeVisible({ timeout: 30_000 });
    await expect(table).toContainText('key-sem-campo'); // antes ficava de fora: o GitLab não informa o último uso
    await expect(table.locator('tr', { hasText: 'key-sem-campo' })).toContainText('Sem validade');
    await expect(admin.page.getByTestId('scan-summary')).toContainText('chave(s) SSH sem validade');
    expect((await control.get<unknown[]>('/keys')).length).toBeGreaterThanOrEqual(1); // nada foi removido
  });
});

test.describe('políticas: validade máxima do PAT', () => {
  const iso = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  test('na ferramenta: salva (auditado) e passa a limitar a data na tela de rotação', async () => {
    await admin.page.getByRole('link', { name: 'Políticas' }).click();
    await expect(admin.page.getByTestId('tool-days')).toHaveText('365 dias');
    await expect(admin.page.getByTestId('gitlab-days')).toHaveText('sem limite');
    await admin.page.getByTestId('pat-days').fill('366');
    await expect(admin.page.getByTestId('save-tool')).toBeDisabled(); // fora de 1–365 a tela nem deixa enviar (o servidor também recusa: ver integração)
    await admin.page.getByTestId('pat-days').fill('45');
    await admin.page.getByTestId('save-tool').click();
    await expect(admin.page.getByTestId('tool-days')).toHaveText('45 dias');
    expect(
      await sql("SELECT 1 FROM audit_log WHERE action='SETTINGS_CHANGED' AND metadata->>'setting'='pat.maxLifetimeDays'"),
    ).toHaveLength(1);

    await admin.page.goto('/token');
    await expect(admin.page.getByTestId('rotate-date')).toHaveAttribute('max', iso(45));
  });

  test('no GitLab: a SIMULAÇÃO avisa que o meu token e os vinculados seriam revogados e não altera nada', async () => {
    await admin.page.goto('/admin/policies');
    await admin.page.getByTestId('pat-days').fill('1');
    await admin.page.getByTestId('simulate').click();
    await expect(admin.page.getByTestId('sim-result')).toBeVisible({ timeout: 30_000 });
    await expect(admin.page.getByTestId('sim-self')).toContainText('seu próprio token seria revogado');
    await expect(admin.page.getByTestId('sim-linked')).toContainText('em uso por contas desta ferramenta');
    expect((await control.get<{ maxPatLifetime: number | null }>('/instance')).maxPatLifetime).toBeNull();
  });

  test('aplicar no GitLab exige simulação, motivo e confirmação digitada; revoga só o previsto', async () => {
    // token de outro usuário que passa de 365 dias: o único afetado (nada do operador/ferramenta é atingido)
    const ana = await control.get<{ id: number }>('/users?username=ana');
    const longo = await control.post<{ token: string }>('/tokens', {
      userId: ana.id,
      name: 'tok-longo',
      expires_at: iso(400),
      scopes: ['api', 'read_user', 'read_api', 'write_repository'],
    });

    await admin.page.goto('/admin/policies');
    await admin.page.getByTestId('pat-days').fill('365');
    await admin.page.getByTestId('simulate').click();
    await expect(admin.page.getByTestId('sim-affected')).toHaveText('1', { timeout: 30_000 });
    await expect(admin.page.getByTestId('sim-self')).toHaveCount(0);
    await expect(admin.page.getByTestId('sim-table')).toContainText('tok-longo');
    // escopos de cada PAT na simulação: privilegiado em destaque, demais compactados, lista completa acessível
    const row = admin.page.locator('tr', { hasText: 'tok-longo' });
    await expect(row.getByTestId('scopes')).toContainText('api');
    await expect(row.getByTestId('scopes')).toContainText('+1'); // api + 2 exibidos + 1 oculto
    await expect(row.getByTestId('scopes')).toContainText('Todos os escopos: api, read_user, read_api, write_repository');
    await expect(admin.page.getByTestId('sim-privileged')).toContainText('1 dos tokens afetados');

    await admin.page.getByTestId('apply-open').click();
    const confirm = admin.page.getByTestId('apply-confirm');
    await expect(confirm).toBeDisabled();
    await admin.page.getByLabel('Motivo / nº da mudança *').fill('CHG0777 - política corporativa de tokens');
    await admin.page.getByLabel(/Digite APLICAR 365/).fill('APLICAR 90'); // valor errado
    await expect(confirm).toBeDisabled();
    await admin.page.getByLabel(/Digite APLICAR 365/).fill('APLICAR 365');
    await confirm.click();
    await expect(admin.page.getByTestId('applied')).toContainText('365 dias');

    expect((await control.get<{ maxPatLifetime: number }>('/instance')).maxPatLifetime).toBe(365);
    expect((await control.get<{ revoked: boolean }>(`/tokens/${longo.token}`)).revoked).toBe(true);
    await expect(admin.page.getByTestId('gitlab-days')).toHaveText('365 dias');
    const [a] = await sql<{ result: string; metadata: { expectedRevocations: number } }>(
      "SELECT result, metadata FROM audit_log WHERE action='GITLAB_POLICY_PAT_LIFETIME_APPLIED'",
    );
    expect(a).toMatchObject({ result: 'SUCCESS', metadata: { expectedRevocations: 1 } });
    // o token do operador continua válido (a ferramenta segue funcionando)
    await admin.page.goto('/gitlab/users?q=maria');
    await expect(admin.page.getByTestId('users-table')).toContainText('maria');
  });
});

test.describe('administração da ferramenta', () => {
  test('admin cria a conta "operador"; a senha temporária aparece uma vez', async () => {
    await admin.page.goto('/admin/users');
    await admin.page.getByTestId('new-account').click();
    const form = admin.page.getByTestId('create-user-dialog');
    await form.getByLabel('Usuário').fill('operador');
    await form.getByLabel('Nome').fill('Operador Teste');
    await form.getByLabel('E-mail').fill('operador@example.com');
    await form.getByLabel('Motivo / nº do chamado *').fill('REQ0001234 - novo operador');
    await form.getByTestId('create-submit').click();

    const secret = admin.page.getByTestId('secret-dialog');
    await expect(secret).toBeVisible();
    const tempPassword = (await admin.page.getByTestId('secret-value').textContent())!.trim();
    expect(tempPassword).toHaveLength(20);
    await secret.getByRole('button', { name: 'Já guardei, fechar' }).click();
    await expect(admin.page.getByTestId('tool-users')).toContainText('operador');
    await admin.page.reload();
    expect(await admin.page.content()).not.toContain(tempPassword);
    expect(JSON.stringify(await sql('SELECT * FROM audit_log'))).not.toContain(tempPassword);

    // login do operador em outro navegador: troca de senha + 2FA obrigatórios
    const ctx = await admin.ctx.browser()!.newContext();
    const page = await ctx.newPage();
    watch(page, 'operador');
    operator = { ctx, page, totpSecret: '' };
    await newIp(ctx);
    await login(page, 'operador', tempPassword);
    await changeInitialPassword(page, tempPassword, OPERATOR_PASSWORD);
    operator.totpSecret = (await setupTwoFactor(page, OPERATOR_PASSWORD)).secret;
    await expect(page.getByRole('heading', { name: /Olá, Operador Teste/ })).toBeVisible();
  });

  test('operador (não admin): sem menu de admin, URLs de admin redirecionam, export negado', async () => {
    const p = operator.page;
    await expect(p.getByRole('link', { name: 'Contas da ferramenta' })).toHaveCount(0);
    await expect(p.getByRole('link', { name: 'Auditoria' })).toHaveCount(0);
    await p.goto('/admin/users');
    await expect(p).toHaveURL(/\/$/);
    await p.goto('/admin/audit');
    await expect(p).toHaveURL(/\/$/);
    for (const path of ['/admin/cleanup', '/admin/policies', '/admin/vault']) {
      await p.goto(path);
      await expect(p).toHaveURL(/\/$/);
    }
    expect((await operator.ctx.request.get('/admin/scans/00000000-0000-4000-8000-000000000000', { maxRedirects: 0 })).status()).toBe(403);
    expect((await operator.ctx.request.get('/admin/audit/export', { maxRedirects: 0 })).status()).toBe(403);
  });

  test('operador vincula um PAT só com self_rotate: sem usuários GitLab; mesmo usuário GitLab não vincula em 2 contas', async () => {
    const p = operator.page;
    await p.goto('/token');
    // o usuário GitLab "root" já está vinculado ao admin da ferramenta
    const second = await control.post<{ token: string }>('/tokens', { userId: 100, scopes: ['api', 'admin_mode'] });
    await p.getByLabel('Personal Access Token do GitLab').fill(second.token);
    await p.getByRole('button', { name: 'Vincular token' }).click();
    await expect(alertOf(p)).toContainText('já está vinculado a outra conta');

    await p.getByLabel('Personal Access Token do GitLab').fill(state().rotateOnlyPat);
    await p.getByRole('button', { name: 'Vincular token' }).click();
    await expect(p.getByTestId('token-card')).toContainText('@devuser');

    await p.goto('/');
    await expect(p.getByTestId('cap-READ_USERS')).toHaveAttribute('data-ok', 'false');
    await expect(p.getByTestId('cap-SELF_ROTATE')).toHaveAttribute('data-ok', 'true');
    await expect(p.getByRole('link', { name: 'Usuários GitLab' })).toHaveCount(0);
    await p.goto('/gitlab/users');
    await expect(p.getByTestId('users-error')).toBeVisible(); // acesso direto pela URL também é barrado
    await expect(p.getByTestId('users-table')).toHaveCount(0);
  });

  test('admin bane o operador: ação sensível seguinte do operador cai no login e novo login é recusado', async () => {
    await admin.page.goto('/admin/users');
    await admin.page.getByTestId('menu-operador').click();
    await admin.page.getByRole('menuitem', { name: 'Banir conta' }).click();
    await admin.page.getByLabel('Motivo / nº do chamado *').fill('REQ0009999 - desligamento');
    await admin.page.getByTestId('admin-confirm').click();
    await expect(admin.page.locator('tr[data-username="operador"]')).toContainText('Banida');

    await operator.page.goto('/token');
    await operator.page.getByTestId('unlink-open').click();
    await operator.page.getByTestId('unlink-confirm').click();
    await expect(operator.page).toHaveURL(/\/login/);

    await login(operator.page, 'operador', OPERATOR_PASSWORD);
    await expect(alertOf(operator.page)).toContainText('Conta desativada');
  });

  test('admin não consegue banir a si mesmo (sem opção no menu)', async () => {
    await admin.page.goto('/admin/users');
    await admin.page.getByTestId('menu-admin').click();
    await expect(admin.page.getByRole('menuitem', { name: 'Banir conta' })).toHaveCount(0);
    await admin.page.keyboard.press('Escape');
  });
});

test.describe('auditoria', () => {
  test('histórico pessoal e auditoria global com filtro; CSV sem segredos', async () => {
    await admin.page.goto('/history?group=GITLAB_USER_'); // filtra: a 1ª página (25 itens) já não alcança as ações antigas
    await expect(admin.page.getByTestId('audit-table')).toContainText('Usuário GitLab desbloqueado');
    await expect(admin.page.getByTestId('audit-table')).not.toContainText('Operador'); // só as ações dele

    await admin.page.goto('/admin/audit?group=TOOL_USER_');
    await expect(admin.page.getByTestId('audit-table')).toContainText('Conta criada');
    await expect(admin.page.getByTestId('audit-table')).toContainText('Conta banida');
    await admin.page.goto('/admin/audit?group=TOOL_USER_');
    const rows = admin.page.getByTestId('audit-table').locator('td[data-action]');
    for (const a of await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-action')))) expect(a).toMatch(/^TOOL_USER_/);

    const csv = await admin.ctx.request.get('/admin/audit/export');
    expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toContain('text/csv');
    const text = await csv.text();
    expect(text).toContain('GITLAB_USER_UNBLOCKED');
    expect(text).toContain('AUTH_LOGIN_FAILED');
    for (const secret of [state().adminPat, newAdminPat, state().rotateOnlyPat, NEW_PASSWORD, OPERATOR_PASSWORD])
      expect(text).not.toContain(secret);
    expect((await admin.ctx.request.get('/admin/audit/export')).status()).toBe(200);
  });

  test('exportação anônima é barrada', async ({ playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: state().appUrl });
    expect((await anon.get('/admin/audit/export', { maxRedirects: 0 })).status()).toBe(307);
    await anon.dispose();
  });

  test('falhas de login e eventos de autenticação foram auditados (sem senhas)', async () => {
    const rows = await sql<{ action: string; actor_username: string }>(
      "SELECT action, actor_username FROM audit_log WHERE action LIKE 'AUTH_%'",
    );
    const actions = rows.map((r) => r.action);
    for (const a of ['AUTH_LOGIN_SUCCESS', 'AUTH_LOGIN_FAILED', 'AUTH_PASSWORD_CHANGED', 'AUTH_2FA_ENABLED', 'AUTH_LOGOUT'])
      expect(actions).toContain(a);
    expect(rows.some((r) => r.actor_username === 'fantasma')).toBe(true);
    expect(JSON.stringify(await sql('SELECT * FROM audit_log'))).not.toMatch(/Errada!Senha/);
  });
});

test.describe('minha conta, saúde e manutenção', () => {
  test('sessões ativas e dados da conta', async () => {
    await admin.page.goto('/account/security');
    await expect(admin.page.getByTestId('account-data')).toContainText('admin@example.com');
    await expect(admin.page.getByTestId('sessions')).toContainText('esta sessão');
    // 2FA obrigatório: não há opção de desativar
    await expect(admin.page.getByText('O 2FA é obrigatório nesta instalação')).toBeVisible();
  });

  test('cookie de sessão é HttpOnly e SameSite=Lax', async () => {
    const c = (await admin.ctx.cookies()).find((x) => x.name === 'gw.session_token');
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
  });

  test('health e manutenção (Bearer, comparação em tempo constante)', async ({ request }) => {
    expect((await request.get('/api/health')).status()).toBe(200);
    expect((await request.post('/api/internal/maintenance')).status()).toBe(401);
    expect((await request.post('/api/internal/maintenance', { headers: { authorization: 'Bearer errado' } })).status()).toBe(401);
    const ok = await request.post('/api/internal/maintenance', { headers: { authorization: `Bearer ${state().maintenanceSecret}` } });
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toHaveProperty('tokensScrubbed');
  });

  test('o endpoint HTTP do better-auth não expõe rotas administrativas', async ({ request }) => {
    const res = await request.post('/api/auth/admin/create-user', {
      data: { email: 'x@x.com', password: 'Abc!defg12345', name: 'x', role: 'admin' },
    });
    expect(res.status()).toBe(404);
  });
});

test.describe('acessibilidade (axe, WCAG 2.1 AA)', () => {
  const paths = [
    '/',
    '/token',
    '/gitlab/users',
    '/admin/users',
    '/admin/audit',
    '/admin/cleanup',
    '/admin/policies',
    '/admin/vault',
    '/account/security',
    '/history',
  ];
  for (const path of paths) {
    test(`sem violações sérias em ${path}`, async () => {
      await admin.page.goto(path);
      await admin.page.waitForLoadState('networkidle');
      const r = await new AxeBuilder({ page: admin.page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(
        bad.map(
          (v) =>
            `${v.id}: ${v.nodes
              .map((n) => n.target.join(' '))
              .slice(0, 3)
              .join(' | ')}`,
        ),
      ).toEqual([]);
    });
  }
  test('sem violações sérias na tela de login', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/login');
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
    await ctx.close();
  });
});

test.describe('cofres de token de projeto', () => {
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  let projectId = 0;
  let appGroupId = 0;
  let oldToken = { id: 0, token: '' };

  test('a tela aparece no menu e a configuração padrão vem preenchida', async () => {
    await admin.page.goto('/');
    await admin.page.getByRole('link', { name: 'Cofres de token' }).click();
    await expect(admin.page.getByRole('heading', { name: 'Cofres de token' })).toBeVisible();
    await expect(admin.page.getByTestId('vault-root')).toHaveValue('seguranca-corporativa');
    await expect(admin.page.getByTestId('vault-warn')).toHaveValue('30');
    await expect(admin.page.getByTestId('vault-life')).toHaveValue('180');
  });

  test('varredura (dry-run) mostra validade, escopos e o plano, sem alterar o GitLab', async () => {
    const root = await control.post<{ id: number }>('/groups', { path: 'seguranca-corporativa' });
    const hml = await control.post<{ id: number }>('/groups', { path: 'hml', parentId: root.id });
    const app = await control.post<{ id: number }>('/groups', { path: 'areacorp-jks' });
    appGroupId = app.id;
    projectId = (await control.post<{ id: number }>('/projects', { groupId: hml.id, path: 'areacorp-jks' })).id;
    oldToken = await control.post<{ id: number; token: string }>('/project-tokens', {
      projectId,
      name: 'cofre-hml-20260101',
      scopes: ['read_api'],
      expires_at: inDays(7),
    });
    await control.post('/variables', { groupId: appGroupId, key: 'PID_HML', value: String(projectId) });
    await control.post('/variables', { groupId: appGroupId, key: 'DEVOPS_HML', value: oldToken.token });

    await admin.page.goto('/admin/vault');
    await admin.page.getByTestId('vault-scan').click();
    const table = admin.page.getByTestId('vault-table');
    await expect(table).toBeVisible({ timeout: 30_000 });
    const row = table.locator('tr', { hasText: 'areacorp-jks' });
    await expect(row).toContainText('Vence em breve');
    await expect(row.getByTestId('scopes')).toContainText('read_api');
    await expect(row).toContainText('Maintainer');
    await expect(row.getByTestId('vault-plan')).toContainText('DEVOPS_HML');
    await expect(row.getByTestId('vault-plan')).toContainText('só depois de validar o novo');
    await expect(admin.page.getByTestId('vault-sum-actionable')).toHaveText('1');
    const vars = await control.get<{ key: string; value: string }[]>('/variables');
    expect(vars.find((v) => v.key === 'DEVOPS_HML')!.value).toBe(oldToken.token); // nada mudou
    const axe = await new AxeBuilder({ page: admin.page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]); // tabela com dados
  });

  test('aplicar exige motivo + APLICAR; rotaciona, grava a variável e revoga o antigo sem expor o valor', async () => {
    await admin.page.getByTestId('vault-select-all').check();
    await admin.page.getByTestId('vault-apply-open').click();
    const confirm = admin.page.getByTestId('vault-apply-confirm');
    await expect(confirm).toBeDisabled();
    await admin.page.getByLabel('Motivo / nº do chamado *').fill('CHG0777 - rotação programada');
    await admin.page.getByLabel(/Digite APLICAR/).fill('aplicar');
    await expect(confirm).toBeDisabled();
    await admin.page.getByLabel(/Digite APLICAR/).fill('APLICAR');
    await confirm.click();
    await expect(admin.page.getByTestId('vault-exec-result')).toContainText('1 concluído(s)');

    const vars = await control.get<{ groupId: number; key: string; value: string }[]>('/variables');
    const devops = vars.find((v) => v.key === 'DEVOPS_HML')!;
    expect(devops.value).not.toBe(oldToken.token);
    const toks = await control.get<{ id: number; token: string; revoked: boolean }[]>('/project-tokens');
    expect(toks.find((t) => t.id === oldToken.id)!.revoked).toBe(true);
    expect(toks.find((t) => t.token === devops.value)!.revoked).toBe(false);
    // o valor do token nunca aparece na tela
    await expect(admin.page.locator('body')).not.toContainText(devops.value);
    const audit = await sql<{ metadata: unknown }>("SELECT metadata FROM audit_log WHERE action LIKE 'VAULT_%'");
    expect(JSON.stringify(audit)).not.toContain(devops.value);
    expect(
      await sql(
        "SELECT 1 FROM audit_log WHERE action='VAULT_TOKEN_ROTATED' AND result='SUCCESS' AND reason='CHG0777 - rotação programada'",
      ),
    ).toHaveLength(1);

    // nova varredura: tudo em ordem
    await admin.page.goto('/admin/vault');
    await admin.page.getByTestId('vault-scan').click();
    await expect(admin.page.getByTestId('vault-table').locator('tr', { hasText: 'areacorp-jks' })).toContainText('OK', { timeout: 30_000 });
  });

  test('forçar renovação inclui o cofre que está OK no plano, marcado como forçado, e rotaciona', async () => {
    await admin.page.goto('/admin/vault');
    await admin.page.getByTestId('vault-force').check();
    await admin.page.getByTestId('vault-scan').click();
    const row = admin.page.getByTestId('vault-table').locator('tr', { hasText: 'areacorp-jks' });
    await expect(row).toContainText('OK', { timeout: 30_000 });
    await expect(row.getByTestId('vault-forced')).toBeVisible();
    const antes = (await control.get<{ key: string; value: string }[]>('/variables')).find((v) => v.key === 'DEVOPS_HML')!.value;

    await admin.page.getByTestId('vault-select-all').check();
    await admin.page.getByTestId('vault-apply-open').click();
    await admin.page.getByLabel('Motivo / nº do chamado *').fill('SEC0001 - renovação forçada preventiva');
    await admin.page.getByLabel(/Digite APLICAR/).fill('APLICAR');
    await admin.page.getByTestId('vault-apply-confirm').click();
    await expect(admin.page.getByTestId('vault-exec-result')).toContainText('1 concluído(s)');
    const depois = (await control.get<{ key: string; value: string }[]>('/variables')).find((v) => v.key === 'DEVOPS_HML')!.value;
    expect(depois).not.toBe(antes);
    const toks = await control.get<{ token: string; revoked: boolean }[]>('/project-tokens');
    expect(toks.find((t) => t.token === antes)!.revoked).toBe(true);
    expect(await sql("SELECT 1 FROM audit_log WHERE action='VAULT_TOKEN_ROTATED' AND metadata->>'forced'='true'")).toHaveLength(1);
  });
});

test.describe('cofres de token: rotação automática', () => {
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  test('habilitar na tela; o gatilho externo rotaciona só o que vence e mostra a última execução', async ({ request }) => {
    const root = (await control.get<{ path: string; id: number }[]>('/groups-list')).find((g) => g.path === 'seguranca-corporativa')!;
    const hml = await control.post<{ id: number }>('/groups', { path: 'prd', parentId: root.id });
    const app = await control.post<{ id: number }>('/groups', { path: 'auto-app' });
    const proj = await control.post<{ id: number }>('/projects', { groupId: hml.id, path: 'auto-app' });
    const old = await control.post<{ id: number; token: string }>('/project-tokens', {
      projectId: proj.id,
      name: 'cofre-prd-20260101',
      scopes: ['read_api'],
      expires_at: inDays(3),
    });
    await control.post('/variables', { groupId: app.id, key: 'PID_PRD', value: String(proj.id) });
    await control.post('/variables', { groupId: app.id, key: 'DEVOPS_PRD', value: old.token });

    await admin.page.goto('/admin/vault');
    await expect(admin.page.getByTestId('vault-auto-state')).toHaveText('desabilitada');
    // desabilitada: o gatilho não faz nada
    const headers = { authorization: `Bearer ${state().maintenanceSecret}` };
    const off = await request.post('/api/internal/vault-auto', { headers });
    expect(await off.json()).toEqual({ ran: false, reason: 'DISABLED' });

    await admin.page.getByTestId('vault-auto-toggle').click();
    await expect(admin.page.getByTestId('vault-auto-state')).toHaveText('habilitada');

    const res = await request.post('/api/internal/vault-auto', { headers });
    const body = (await res.json()) as { ran: boolean; status: { candidates: number; done: number; problem: string | null } };
    expect(body).toMatchObject({ ran: true, status: { candidates: 1, done: 1, problem: null } });
    const vars = await control.get<{ key: string; value: string }[]>('/variables');
    expect(vars.find((v) => v.key === 'DEVOPS_PRD')!.value).not.toBe(old.token);
    const toks = await control.get<{ id: number; revoked: boolean }[]>('/project-tokens');
    expect(toks.find((t) => t.id === old.id)!.revoked).toBe(true);
    expect(JSON.stringify(body)).not.toContain(old.token);

    await admin.page.reload();
    await expect(admin.page.getByTestId('vault-auto-status')).toContainText('1 candidato(s): 1 concluído(s)');
    expect(await sql("SELECT 1 FROM audit_log WHERE action='VAULT_TOKEN_ROTATED' AND metadata->>'auto'='true'")).toHaveLength(1);

    await admin.page.getByTestId('vault-auto-toggle').click();
    await expect(admin.page.getByTestId('vault-auto-state')).toHaveText('desabilitada');
  });
});

test('nenhum erro de console, de página ou violação de CSP durante todo o roteiro', () => {
  expect(problems).toEqual([]);
});
