-- Nova capability VAULT_TOKENS (derivada do scope `api`) para os tokens já vinculados.
UPDATE "gitlab_token"
SET "capabilities" = array_append("capabilities", 'VAULT_TOKENS')
WHERE 'api' = ANY("scopes") AND NOT ('VAULT_TOKENS' = ANY("capabilities"));
