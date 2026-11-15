'use client';
import { Eye, EyeOff } from 'lucide-react';
import { forwardRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export const PasswordField = forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(function PasswordField(props, ref) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input ref={ref} type={show ? 'text' : 'password'} autoComplete="off" className="pr-10" {...props} />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute top-0.5 right-0.5"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}
      >
        {show ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  );
});
