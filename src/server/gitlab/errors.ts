import 'server-only';

export type GitLabErrorCode =
  | 'GITLAB_TOKEN_INVALID'
  | 'GITLAB_FORBIDDEN'
  | 'GITLAB_LDAP_BLOCKED'
  | 'GITLAB_2FA_NOT_ENABLED'
  | 'GITLAB_NOT_FOUND'
  | 'GITLAB_BAD_REQUEST'
  | 'GITLAB_RATE_LIMITED'
  | 'GITLAB_UNAVAILABLE'
  | 'GITLAB_TLS_ERROR'
  | 'GITLAB_ROTATION_UNKNOWN'
  | 'GITLAB_UNEXPECTED_RESPONSE';

/** Erro da API do GitLab já traduzido. Nunca carrega o token nem o corpo bruto da resposta. */
export class GitLabApiError extends Error {
  constructor(
    public readonly code: GitLabErrorCode,
    public readonly status: number | null,
    message: string,
    public readonly retryable = false,
    /** Trecho curto do `message` devolvido pelo GitLab (sem o token), só para diagnóstico na UI/auditoria. */
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'GitLabApiError';
  }
}
