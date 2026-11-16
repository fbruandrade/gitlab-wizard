'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const PHASES: Record<string, string> = {
  starting: 'Iniciando…',
  users: 'Lendo usuários',
  tokens: 'Lendo tokens',
  keys: 'Lendo chaves SSH',
  groups: 'Lendo grupos e projetos',
  vaults: 'Inspecionando cofres',
  classify: 'Classificando',
  done: 'Concluída',
};

/** Acompanha uma varredura em andamento (polling) e recarrega a página quando termina. */
export function ScanStatus({ scanId }: { scanId: string }) {
  const router = useRouter();
  const [text, setText] = useState('Iniciando…');

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/admin/scans/${scanId}`, { cache: 'no-store' });
        if (!alive) return;
        if (res.ok) {
          const s = (await res.json()) as { status: string; progress?: { phase?: string; done?: number; total?: number } | null };
          if (s.status !== 'RUNNING') return router.refresh();
          const p = s.progress ?? {};
          setText(`${PHASES[p.phase ?? 'starting'] ?? p.phase}${p.total ? ` (${p.done ?? 0}/${p.total})` : p.done ? ` (${p.done})` : ''}`);
        }
      } catch {
        /* rede instável: tenta de novo no próximo ciclo */
      }
      if (alive) timer = setTimeout(tick, 1500);
    };
    let timer = setTimeout(tick, 500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [scanId, router]);

  return (
    <p role="status" className="text-sm text-muted-foreground" data-testid="scan-running">
      Varredura em andamento: {text}
    </p>
  );
}
