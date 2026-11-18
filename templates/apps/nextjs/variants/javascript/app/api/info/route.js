import { connection } from 'next/server';

export async function GET() {
  // Read the environment per request, not once at build time.
  await connection();
  return Response.json({
    service: process.env.ORBIT_APP ?? '{{APP_NAME}}',
    status: 'ok',
    environment: process.env.ORBIT_ENV ?? 'local',
  });
}
