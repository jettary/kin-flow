import { after, NextRequest } from 'next/server';
import { appURL } from '@/server/auth';
import { getDB } from '@/server/db';
import { handleMcp } from '@/server/mcp';
import { deliverPush } from '@/server/push';
export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

async function handle(request: NextRequest) {
  const response = await handleMcp(request, appURL(request));
  // Tool calls may queue push notifications; deliver them after the response, as the app API does.
  if (request.method === 'POST' && response.ok)
    after(async () => {
      try {
        await deliverPush(await getDB());
      } catch {
        console.error('KinFlow push delivery failed');
      }
    });
  return response;
}
export { handle as GET, handle as POST, handle as DELETE };
