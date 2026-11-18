import { connection } from 'next/server';
import { Suspense } from 'react';

// Rendered per request: the page itself is prerendered at build time, and this
// part streams in with values that only exist at runtime.
async function Environment() {
  await connection();
  return <code>{process.env.ORBIT_ENV ?? 'local'}</code>;
}

export default function Home() {
  return (
    <main>
      <h1>{{APP_NAME}}</h1>
      <p>
        Owned by <strong>{{TEAM}}</strong>. Edit <code>app/page.tsx</code> and push to <code>main</code> to deploy.
      </p>
      <dl>
        <dt>Environment</dt>
        <dd>
          <Suspense fallback={<code>…</code>}>
            <Environment />
          </Suspense>
        </dd>
        <dt>API</dt>
        <dd>
          <a href="/api/info">/api/info</a>
        </dd>
        <dt>Metrics</dt>
        <dd>
          <a href="/metrics">/metrics</a>
        </dd>
      </dl>
    </main>
  );
}
