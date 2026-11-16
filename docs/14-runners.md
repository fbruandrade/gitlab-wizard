# 14 — Runners (global, de grupo e de projeto)

> **Status (16/11/2026): implementado e testado** (tela `/runners`; 10 testes de integração + 1 de ações + unitários + 1 roteiro E2E). Os endpoints foram conferidos na documentação do GitLab, **mas só foram exercitados contra o GitLab falso**: validar na sua versão (fase 0).

## O que a ferramenta faz
1. **Cria** o runner no GitLab (`POST /user/runners`, o fluxo atual com token de autenticação `glrt-…`) e mostra **uma única vez**, nesta ordem: (1) o **token** do runner; (2) o comando de registro para uma **máquina com gitlab-runner** (`gitlab-runner register --non-interactive --url <GitLab> --token glrt-… --executor docker --docker-image alpine:latest`, ou `shell`); (3) os comandos para **Kubernetes com Helm**: `helm repo add gitlab https://charts.gitlab.io && helm repo update` e `helm upgrade --install gitlab-runner gitlab/gitlab-runner --namespace gitlab-runner --create-namespace --set gitlabUrl=<GitLab> --set runnerToken=glrt-… --set rbac.create=true` (idempotente; ajuste namespace/release; para GitLab com certificado interno, use `certsSecretName` do chart). Cada bloco tem botão Copiar.
2. **Lista** os runners de um escopo (global, grupo ou projeto), com estado (online, offline, sem contato, nunca conectou), pausa e tags.
3. **Pausa/retoma** e **remove** (motivo + digitar `REMOVER`).

A ferramenta **não instala** o `gitlab-runner` nem sobe a máquina/contêiner: ela cria a entidade no GitLab e entrega o token. O registro é feito por quem opera o host.

## Tipos e permissões
| Tipo | Quem cria (GitLab) | Na ferramenta |
|---|---|---|
| Global (compartilhado da instância, `instance_type`) | administrador do GitLab | opção só habilitada para token de admin; recusado antes de chamar o GitLab se não for |
| De grupo (`group_type`) | **Owner** do grupo | busca entre os grupos em que você é Owner |
| De projeto (`project_type`) | **Owner** do projeto (o plano antigo dizia Maintainer; a doc atual diz Owner) | busca entre os projetos em que você é Owner; "travar neste projeto" |

Pode ser preciso que o **registro de runners esteja permitido** no grupo/projeto/instância (senão o GitLab responde 403).

## Scopes do token (capabilities novas)
- **`create_runner`** → `RUNNERS_CREATE` (criar e buscar alvos). **O scope `api` não basta**, segundo a documentação.
- **`manage_runner`** ou `api` → `RUNNERS_MANAGE` (listar, pausar, remover).
A migração marca os tokens já vinculados. O item **Runners** aparece no menu para quem tem uma das duas.

## Parâmetros na criação
Descrição, **tags** (até 20; ao menos uma, ou marcar "jobs sem tag"), jobs sem tag, só branches/tags protegidos (`ref_protected`), travar no projeto (só projeto), criar pausado, tempo máximo do job (10 min a 30 dias), executor do comando de registro (docker/shell) e **motivo** (≥ 10 caracteres, auditado). Validade do token do runner (`token_expires_at`, Premium/Ultimate) **não** foi exposta.

## Segurança
- O token do runner existe só na resposta da criação: **não é gravado** no banco, nem na auditoria, nem em log. Fica no estado da tela até você fechar o diálogo ("Já guardei, fechar").
- Auditoria: `RUNNER_CREATED`, `RUNNER_PAUSED`, `RUNNER_DELETED`, com tipo, alvo, id do runner, tags e motivo (sem token).
- Escrita **sem retry**. Se a criação der timeout, o runner pode ter sido criado: confira na lista antes de repetir.
- Pausar/remover só agem em runner que aparece **na lista do escopo informado** (não apaga "por id" de outro lugar).
- Todas as ações exigem sessão fresca (login recente).

## Como validar na sua instância (fase 0)
1. Versão do GitLab (≥ 16.0 para o fluxo `glrt-`). 2. Token com `create_runner` e papel Owner (ou admin). 3. Criar um runner global de teste, rodar o comando de registro num host de homologação e ver o runner **online**. 4. Confirmar o 403 quando o registro está desabilitado. 5. Confirmar se `api` basta para listar na sua versão (`manage_runner` é o scope documentado).

## Fora do escopo (próximos passos possíveis)
Provisionar o host/contêiner do runner (docker compose, Kubernetes), editar tags de um runner existente, redefinir o token de um runner, expiração do token do runner e métricas de fila/uso.
