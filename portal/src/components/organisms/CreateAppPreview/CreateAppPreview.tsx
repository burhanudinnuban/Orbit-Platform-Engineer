import { BASE_DOMAIN, GOLDEN_PATH } from '@/features/apps/apps.form'

interface CreateAppPreviewProps {
  /** The typed name once it is valid, else the `<name>` placeholder. */
  name: string
  envs: string[]
  bucket: boolean
  queue: boolean
  /** Prefix of cloud resource names (`ORBIT_CLOUD_NAME_PREFIX`). */
  namePrefix: string | undefined
}

/** What the form will create, and the golden-path steps that will create it. */
export default function CreateAppPreview({
  name,
  envs,
  bucket,
  queue,
  namePrefix,
}: CreateAppPreviewProps) {
  return (
    <aside className="new-aside">
      <section className="card preview">
        <h2>Preview</h2>
        <dl className="kv">
          <dt>Repository</dt>
          <dd className="mono">apps/{name}</dd>
          {(envs.length ? envs : ['<env>']).map((env) => (
            <div key={env} className="kv-group">
              <dt>Namespace</dt>
              <dd className="mono">
                {name}-{env}
              </dd>
              <dt>URL</dt>
              <dd className="mono break">
                http://{name}-{env}.{BASE_DOMAIN}
              </dd>
              {bucket ? (
                <>
                  <dt>S3 bucket</dt>
                  <dd className="mono break">
                    {namePrefix}-{name}-{env}
                  </dd>
                </>
              ) : null}
              {queue ? (
                <>
                  <dt>SQS queue</dt>
                  <dd className="mono break">
                    {namePrefix}-{name}-{env}
                  </dd>
                </>
              ) : null}
            </div>
          ))}
        </dl>
      </section>
      <section className="card">
        <h2>What will happen</h2>
        <ol className="golden-path">
          {GOLDEN_PATH.map((step, i) => (
            <li key={step.title}>
              <span className="gp-num">{i + 1}</span>
              <span>
                <strong>{step.title}</strong>
                <span className="muted small block">
                  {step.detail
                    .replace('<name>', name)
                    .replace('<env>', envs[0] ?? '<env>')}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </aside>
  )
}
