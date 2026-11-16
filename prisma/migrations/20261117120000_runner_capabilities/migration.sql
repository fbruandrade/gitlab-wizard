-- Novas capabilities de runners, derivadas dos scopes dos tokens já vinculados.
UPDATE "gitlab_token"
SET "capabilities" = array_append("capabilities", 'RUNNERS_CREATE')
WHERE 'create_runner' = ANY("scopes") AND NOT ('RUNNERS_CREATE' = ANY("capabilities"));

UPDATE "gitlab_token"
SET "capabilities" = array_append("capabilities", 'RUNNERS_MANAGE')
WHERE ('api' = ANY("scopes") OR 'manage_runner' = ANY("scopes")) AND NOT ('RUNNERS_MANAGE' = ANY("capabilities"));
