'use client';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { formatDateTime } from '@/lib/format';

interface Row {
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function SessionsList() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [list, me] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
      if (!alive) return;
      setRows((list.data as Row[] | null) ?? []);
      setCurrent(me.data?.session.token ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [version]);

  if (!rows) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-md border" data-testid="sessions">
        {rows.map((s) => (
          <li key={s.token} className="flex items-center justify-between gap-3 p-3 text-sm">
            <div className="min-w-0">
              <p className="truncate">
                {s.userAgent ?? 'Dispositivo desconhecido'} {s.token === current && <Badge className="ml-1">esta sessão</Badge>}
              </p>
              <p className="text-xs text-muted-foreground">
                {s.ipAddress ?? 'IP não registrado'} · criada em {formatDateTime(s.createdAt)} · última atividade{' '}
                {formatDateTime(s.updatedAt)}
              </p>
            </div>
            {s.token !== current && (
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await authClient.revokeSession({ token: s.token });
                  toast.success('Sessão encerrada.');
                  reload();
                }}
              >
                Encerrar
              </Button>
            )}
          </li>
        ))}
      </ul>
      {rows.length > 1 && (
        <Button
          variant="outline"
          onClick={async () => {
            await authClient.revokeOtherSessions();
            toast.success('Outras sessões encerradas.');
            reload();
          }}
        >
          Encerrar todas as outras
        </Button>
      )}
    </div>
  );
}
