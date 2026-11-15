import { authHandler } from '@/server/auth/handler';

export const dynamic = 'force-dynamic';

// Só GET (get-session) e POST são usados pela UI.
export const GET = authHandler;
export const POST = authHandler;
