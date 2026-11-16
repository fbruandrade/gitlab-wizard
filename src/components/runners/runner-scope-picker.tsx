'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { type RunnerType } from '@/lib/runner-rules';
import { TargetPicker, type PickedTarget } from './target-picker';

/** Escolhe o escopo cujos runners serão listados (a lista é renderizada no servidor, via ?type=&id=). */
export function RunnerScopePicker({ canInstance, current }: { canInstance: boolean; current: { type: RunnerType; id?: number } | null }) {
  const router = useRouter();
  const [type, setType] = useState<RunnerType>(current?.type ?? (canInstance ? 'instance_type' : 'group_type'));
  const [target, setTarget] = useState<PickedTarget | null>(null);
  const ok = type === 'instance_type' || target;
  return (
    <div className="space-y-3" data-testid="runner-scope">
      <TargetPicker idPrefix="rs" type={type} onType={setType} target={target} onTarget={setTarget} canInstance={canInstance} />
      <Button
        variant="outline"
        disabled={!ok}
        data-testid="rs-list"
        onClick={() =>
          router.push((type === 'instance_type' ? '/runners?type=instance_type' : `/runners?type=${type}&id=${target!.id}`) as never)
        }
      >
        Listar runners
      </Button>
    </div>
  );
}
