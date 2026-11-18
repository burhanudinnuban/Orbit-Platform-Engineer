import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import FieldError from '@/components/atoms/FieldError/FieldError'
import InlineError from '@/components/atoms/InlineError/InlineError'
import ErrorState from '@/components/molecules/ErrorState/ErrorState'
import LoadingState from '@/components/molecules/LoadingState/LoadingState'
import CreateAppPreview from '@/components/organisms/CreateAppPreview/CreateAppPreview'
import { appPath, ROUTES } from '@/constants/routes'
import { createAppApi } from '@/features/apps/apps.api'
import {
  GATES,
  languageLabel,
  SIZES,
  validateName,
  validateTeam,
} from '@/features/apps/apps.form'
import type {
  AppSize,
  CreateAppRequest,
  SecurityGate,
} from '@/features/apps/apps.types'
import { fetchPlatformApi } from '@/features/platform/platform.api'
import { usePoll } from '@/hooks/usePoll'
import { errorMessage } from '@/services/http'

/**
 * The one form behind the golden path, with a live preview of what it creates.
 *
 * Templates, environments and the cloud provider come from the platform, so
 * the form waits for that answer before it can be submitted.
 */
export default function CreateAppForm() {
  const navigate = useNavigate()
  const platform = usePoll(() => fetchPlatformApi(), [], 0)
  const info = platform.data

  const [name, setName] = useState('')
  const [team, setTeam] = useState('')
  const [description, setDescription] = useState('')
  // '' and null mean "not chosen yet"; see the defaults derived below.
  const [templateChoice, setTemplate] = useState('')
  const [languageChoice, setLanguage] = useState('')
  const [envChoice, setEnvs] = useState<string[] | null>(null)
  const [database, setDatabase] = useState(false)
  const [objectStorage, setObjectStorage] = useState(false)
  const [queue, setQueue] = useState(false)
  const [size, setSize] = useState<AppSize>('small')
  const [gate, setGate] = useState<SecurityGate>('high')
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string>()

  // Until the user picks, the first template and environment are preselected.
  const environments = info?.environments ?? []
  const template = templateChoice || info?.templates[0]?.id || ''
  const templateInfo = info?.templates.find((t) => t.id === template)
  const languages = templateInfo?.languages ?? []
  // The choice carries over between templates that offer the same language.
  const language = languages.includes(languageChoice)
    ? languageChoice
    : (templateInfo?.language ?? '')
  const selectedEnvs = envChoice ?? environments.slice(0, 1)
  const nameError = validateName(name)
  const teamError = validateTeam(team)
  const envError =
    selectedEnvs.length === 0 ? 'Pick at least one environment.' : undefined
  const templateError = !template ? 'Pick a template.' : undefined
  const descError =
    description.length > 200 ? 'Use at most 200 characters.' : undefined
  const valid =
    !nameError && !teamError && !envError && !templateError && !descError
  const show = (field: string) => submitted || touched[field]
  const previewName = name && !nameError ? name : '<name>'
  const cloud = info?.cloud
  const cloudOff = !cloud || cloud.provider === 'none'
  const cloudLabel =
    cloud?.provider === 'floci'
      ? 'Floci, the local AWS emulator'
      : `AWS ${cloud?.region ?? ''}`
  const wantsBucket = objectStorage && !cloudOff
  const wantsQueue = queue && !cloudOff

  const toggleEnv = (env: string) => {
    setEnvs((cur) => {
      const list = cur ?? selectedEnvs
      return list.includes(env) ? list.filter((e) => e !== env) : [...list, env]
    })
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    setSubmitError(undefined)
    if (!valid) return
    const req: CreateAppRequest = {
      name,
      team,
      template,
      language: language || undefined,
      description: description.trim() || undefined,
      environments: environments.filter((env) => selectedEnvs.includes(env)),
      options: {
        database,
        objectStorage: wantsBucket,
        queue: wantsQueue,
        size,
        securityGate: gate,
      },
    }
    setSubmitting(true)
    try {
      const app = await createAppApi(req)
      navigate(appPath(app.name))
    } catch (err) {
      setSubmitError(errorMessage(err))
      setSubmitting(false)
    }
  }

  return (
    <div className="new-layout">
      <form className="card form" onSubmit={submit} noValidate>
        <section className="form-section">
          <h2>Basics</h2>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input
              id="name"
              className={`input mono ${show('name') && nameError ? 'invalid' : ''}`}
              value={name}
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
              placeholder="payments"
              onChange={(e) => setName(e.target.value.toLowerCase())}
              onBlur={() => setTouched((t) => ({ ...t, name: true }))}
              aria-invalid={Boolean(show('name') && nameError)}
              aria-describedby="name-help"
            />
            <div
              id="name-help"
              className={
                show('name') && nameError ? 'field-error' : 'field-help'
              }
            >
              {show('name') && nameError
                ? nameError
                : 'DNS-safe, up to 30 characters. Used for the repo, namespace and URL.'}
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="team">Team</label>
              <input
                id="team"
                className={`input ${show('team') && teamError ? 'invalid' : ''}`}
                value={team}
                placeholder="core-banking"
                autoComplete="off"
                onChange={(e) => setTeam(e.target.value.toLowerCase())}
                onBlur={() => setTouched((t) => ({ ...t, team: true }))}
                aria-invalid={Boolean(show('team') && teamError)}
              />
              {show('team') && teamError ? (
                <div className="field-error">{teamError}</div>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor="description">
                Description <span className="muted">(optional)</span>
              </label>
              <input
                id="description"
                className={`input ${descError ? 'invalid' : ''}`}
                value={description}
                placeholder="Payment processing API"
                onChange={(e) => setDescription(e.target.value)}
              />
              {descError ? (
                <div className="field-error">{descError}</div>
              ) : null}
            </div>
          </div>
        </section>

        <section className="form-section">
          <h2>Template</h2>
          {platform.loading && !info ? (
            <LoadingState label="Loading templates…" />
          ) : !info ? (
            <ErrorState
              error={platform.error}
              onRetry={() => void platform.refresh()}
            />
          ) : info.templates.length === 0 ? (
            <div className="muted">
              No templates are registered on this platform.
            </div>
          ) : (
            <div
              className="choice-grid"
              role="radiogroup"
              aria-label="Template"
            >
              {info.templates.map((t) => (
                <label
                  key={t.id}
                  className={`choice ${template === t.id ? 'selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="template"
                    value={t.id}
                    checked={template === t.id}
                    onChange={() => setTemplate(t.id)}
                  />
                  <span className="choice-title">
                    {t.name}{' '}
                    {t.languages.map((l) => (
                      <span key={l} className="tag">
                        {languageLabel(l)}
                      </span>
                    ))}
                  </span>
                  <span className="choice-desc">{t.description}</span>
                </label>
              ))}
            </div>
          )}
          {languages.length > 1 ? (
            <div className="field">
              <span className="label">Language</span>
              <div
                className="segmented compact"
                role="radiogroup"
                aria-label="Language"
              >
                {languages.map((l) => (
                  <label key={l} className={language === l ? 'selected' : ''}>
                    <input
                      type="radio"
                      name="language"
                      checked={language === l}
                      onChange={() => setLanguage(l)}
                    />
                    <span className="seg-label">{languageLabel(l)}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <section className="form-section">
          <h2>Environments</h2>
          {info ? (
            <>
              <div className="check-row">
                {environments.map((env) => (
                  <label
                    key={env}
                    className={`check-pill ${selectedEnvs.includes(env) ? 'selected' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedEnvs.includes(env)}
                      onChange={() => toggleEnv(env)}
                    />
                    {env}
                  </label>
                ))}
              </div>
              {show('envs') || submitted ? (
                <FieldError message={envError} />
              ) : null}
            </>
          ) : (
            <div className="muted small">
              Environments load with the platform info.
            </div>
          )}
        </section>

        <section className="form-section">
          <h2>Options</h2>
          <label className="switch-row">
            <input
              type="checkbox"
              checked={database}
              onChange={(e) => setDatabase(e.target.checked)}
            />
            <span className="switch" aria-hidden="true" />
            <span>
              <strong>Postgres database</strong>
              <span className="muted small block">
                Provisioned by Terraform in the app namespace. The app receives{' '}
                <span className="mono">DATABASE_URL</span>.
              </span>
            </span>
          </label>

          <label className={`switch-row ${cloudOff ? 'disabled' : ''}`}>
            <input
              type="checkbox"
              checked={wantsBucket}
              disabled={cloudOff}
              onChange={(e) => setObjectStorage(e.target.checked)}
            />
            <span className="switch" aria-hidden="true" />
            <span>
              <strong>S3 bucket</strong>
              <span className="muted small block">
                {cloudOff ? (
                  'Cloud resources are disabled on this platform.'
                ) : (
                  <>
                    Created in {cloudLabel}. The app receives{' '}
                    <span className="mono">S3_BUCKET</span> and the AWS
                    settings.
                  </>
                )}
              </span>
            </span>
          </label>

          <label className={`switch-row ${cloudOff ? 'disabled' : ''}`}>
            <input
              type="checkbox"
              checked={wantsQueue}
              disabled={cloudOff}
              onChange={(e) => setQueue(e.target.checked)}
            />
            <span className="switch" aria-hidden="true" />
            <span>
              <strong>SQS queue</strong>
              <span className="muted small block">
                {cloudOff ? (
                  'Cloud resources are disabled on this platform.'
                ) : (
                  <>
                    With a dead-letter queue, in {cloudLabel}. The app receives{' '}
                    <span className="mono">SQS_QUEUE_URL</span>.
                  </>
                )}
              </span>
            </span>
          </label>

          <div className="field">
            <span className="label">Size</span>
            <div className="segmented" role="radiogroup" aria-label="Size">
              {SIZES.map((s) => (
                <label key={s.id} className={size === s.id ? 'selected' : ''}>
                  <input
                    type="radio"
                    name="size"
                    checked={size === s.id}
                    onChange={() => setSize(s.id)}
                  />
                  <span className="seg-label">{s.label}</span>
                  <span className="seg-hint">{s.hint}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="label">Security gate</span>
            <div
              className="segmented"
              role="radiogroup"
              aria-label="Security gate"
            >
              {GATES.map((g) => (
                <label key={g.id} className={gate === g.id ? 'selected' : ''}>
                  <input
                    type="radio"
                    name="gate"
                    checked={gate === g.id}
                    onChange={() => setGate(g.id)}
                  />
                  <span className="seg-label">{g.label}</span>
                  <span className="seg-hint">{g.hint}</span>
                </label>
              ))}
            </div>
          </div>
        </section>

        <InlineError message={submitError} />
        <div className="form-actions">
          <Link to={ROUTES.HOME} className="btn">
            Cancel
          </Link>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting || !info}
          >
            {submitting ? 'Creating…' : 'Create application'}
          </button>
        </div>
      </form>

      <CreateAppPreview
        name={previewName}
        envs={selectedEnvs}
        bucket={wantsBucket}
        queue={wantsQueue}
        namePrefix={cloud?.namePrefix}
      />
    </div>
  )
}
