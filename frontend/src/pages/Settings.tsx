import { useEffect, useState } from 'react'
import { api } from '../api/client'

// ── Generic helpers ────────────────────────────────────────────────────────────
type Settings = Record<string, unknown>

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-4 items-start py-4 border-b border-gray-800 last:border-0">
      <div>
        <p className="text-sm font-medium text-white">{label}</p>
        {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      </div>
      <div className="col-span-2">{children}</div>
    </div>
  )
}

function TextInput({ value, onChange, placeholder = '', secret = false, mono = false }: {
  value: string; onChange: (v: string) => void
  placeholder?: string; secret?: boolean; mono?: boolean
}) {
  return (
    <input
      type={secret ? 'password' : 'text'}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 ${mono ? 'font-mono' : ''}`}
    />
  )
}

function NumberInput({ value, onChange, min, max }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number
}) {
  return (
    <input
      type="number" min={min} max={max}
      value={value}
      onChange={e => onChange(parseInt(e.target.value) || 0)}
      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  )
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${value ? 'bg-blue-600' : 'bg-gray-700'}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${value ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  )
}

function SelectInput({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

// Badge for "Phase 5" to mark not-yet-active features
function Phase5Badge() {
  return (
    <span className="ml-2 text-xs bg-gray-800 text-gray-400 border border-gray-700 rounded px-1.5 py-0.5">
      Phase 5
    </span>
  )
}

// ── Section wrapper with Save ─────────────────────────────────────────────────
function Section({
  title, children, onSave, saving, saved, error,
}: {
  title: string
  children: React.ReactNode
  onSave: () => Promise<void>
  saving: boolean
  saved: boolean
  error: string
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-800">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
      </div>
      <div className="px-6 py-2">
        {children}
      </div>
      <div className="px-6 py-4 border-t border-gray-800 flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={saving}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-xs text-green-400">Saved</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  )
}

// ── Per-tab save state ────────────────────────────────────────────────────────
interface SaveState { saving: boolean; saved: boolean; error: string }
const INIT: SaveState = { saving: false, saved: false, error: '' }

function useSave(keys: string[], settings: Settings, onSuccess: () => void) {
  const [state, setState] = useState<SaveState>(INIT)

  const save = async () => {
    setState({ saving: true, saved: false, error: '' })
    try {
      const subset: Settings = {}
      for (const k of keys) if (k in settings) subset[k] = settings[k]
      await api.bulkUpdateSettings(subset)
      setState({ saving: false, saved: true, error: '' })
      onSuccess()
      setTimeout(() => setState(s => ({ ...s, saved: false })), 3000)
    } catch (e: any) {
      setState({ saving: false, saved: false, error: e.message || 'Save failed' })
    }
  }

  return { ...state, save }
}

// ── Main page ─────────────────────────────────────────────────────────────────
type TabId = 'general' | 'storage' | 'ingest' | 'auth' | 'notifications' | 'devices'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'general',       label: 'General' },
  { id: 'storage',       label: 'Storage' },
  { id: 'ingest',        label: 'Ingest' },
  { id: 'auth',          label: 'Auth' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'devices',       label: 'Devices' },
]

export default function Settings() {
  const [tab, setTab]         = useState<TabId>('general')
  const [settings, setSettings] = useState<Settings>({})
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try { setSettings(await api.getSettings()) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const set = (key: string, value: unknown) =>
    setSettings(s => ({ ...s, [key]: value }))

  const str  = (k: string, fallback = '') => (settings[k] as string) ?? fallback
  const num  = (k: string, fallback = 0)  => (settings[k] as number) ?? fallback
  const bool = (k: string, fallback = false) => (settings[k] as boolean) ?? fallback

  // Per-tab save helpers
  const generalSave = useSave(['app_name', 'base_url', 'timezone', 'anthropic_api_key', 'ai_model'], settings, load)
  const storageSave = useSave(['storage_backend', 'retention_days_raw', 'retention_days_hourly'], settings, load)
  const ingestSave  = useSave([
    'ingest_method', 'ingest_token', 'ingest_http_port',
    'ingest_udp_port_netflow', 'ingest_udp_port_sflow',
    'allowed_hosts', 'migration_mode', 'migration_o2_url',
  ], settings, load)
  const authSave = useSave([
    'auth_local_enabled', 'auth_okta_enabled', 'okta_issuer', 'okta_client_id',
    'okta_client_secret', 'okta_redirect_uri', 'session_timeout_minutes',
  ], settings, load)
  const notifySave = useSave([
    'notify_slack_enabled', 'notify_slack_webhook_url', 'notify_slack_channel',
    'notify_email_enabled', 'notify_email_smtp_host', 'notify_email_smtp_port',
    'notify_email_smtp_tls', 'notify_email_username', 'notify_email_password',
    'notify_email_from', 'notify_email_default_to',
    'notify_pagerduty_enabled', 'notify_pagerduty_integration_key',
    'notify_webhook_enabled', 'notify_webhook_url',
    'notify_webhook_method', 'notify_webhook_payload_template',
  ], settings, load)

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500">
        <p className="text-sm">Loading settings…</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-white">Settings</h1>

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`text-sm px-4 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
              tab === t.id ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* General */}
      {tab === 'general' && (
        <Section title="General" onSave={generalSave.save} saving={generalSave.saving} saved={generalSave.saved} error={generalSave.error}>
          <Field label="App name" hint="Displayed in browser tab and header">
            <TextInput value={str('app_name', 'pktFlow')} onChange={v => set('app_name', v)} />
          </Field>
          <Field label="Base URL" hint="Used for redirect URIs and notification links">
            <TextInput value={str('base_url')} onChange={v => set('base_url', v)} placeholder="http://10.20.30.5:8080" />
          </Field>
          <Field label="Timezone" hint="Affects display of timestamps in the UI">
            <SelectInput
              value={str('timezone', 'UTC')}
              onChange={v => set('timezone', v)}
              options={[
                { value: 'UTC', label: 'UTC' },
                { value: 'America/New_York', label: 'Eastern (ET)' },
                { value: 'America/Chicago', label: 'Central (CT)' },
                { value: 'America/Denver', label: 'Mountain (MT)' },
                { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
              ]}
            />
          </Field>

          <div className="pt-4 pb-1">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              AI Assistant (Claude)
            </p>
          </div>
          <Field
            label="Anthropic API key"
            hint="Required for the in-app AI assistant. Get a key at console.anthropic.com. Separate from Claude Enterprise."
          >
            <TextInput
              value={str('anthropic_api_key')}
              onChange={v => set('anthropic_api_key', v)}
              placeholder="sk-ant-…"
              secret
              mono
            />
          </Field>
          <Field label="AI model" hint="Model used for the assistant. Haiku is fast and cost-effective.">
            <SelectInput
              value={str('ai_model', 'claude-haiku-4-5-20251001')}
              onChange={v => set('ai_model', v)}
              options={[
                { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku (fast, low cost)' },
                { value: 'claude-sonnet-4-6', label: 'Claude Sonnet (balanced)' },
                { value: 'claude-opus-4-8', label: 'Claude Opus (most capable)' },
              ]}
            />
          </Field>
        </Section>
      )}

      {/* Storage */}
      {tab === 'storage' && (
        <Section title="Storage" onSave={storageSave.save} saving={storageSave.saving} saved={storageSave.saved} error={storageSave.error}>
          <Field label="Backend" hint="ClickHouse recommended for production; DuckDB for lightweight installs">
            <SelectInput
              value={str('storage_backend', 'clickhouse')}
              onChange={v => set('storage_backend', v)}
              options={[
                { value: 'clickhouse', label: 'ClickHouse (recommended)' },
                { value: 'duckdb', label: 'DuckDB' },
              ]}
            />
          </Field>
          <Field label="Raw flow retention" hint="Days to keep individual flow records">
            <div className="flex items-center gap-3">
              <NumberInput value={num('retention_days_raw', 90)} onChange={v => set('retention_days_raw', v)} min={1} max={3650} />
              <span className="text-sm text-gray-400">days</span>
            </div>
          </Field>
          <Field label="Hourly rollup retention" hint="Days to keep per-hour aggregated data">
            <div className="flex items-center gap-3">
              <NumberInput value={num('retention_days_hourly', 365)} onChange={v => set('retention_days_hourly', v)} min={1} max={3650} />
              <span className="text-sm text-gray-400">days</span>
            </div>
          </Field>
        </Section>
      )}

      {/* Ingest */}
      {tab === 'ingest' && (
        <Section title="Ingest" onSave={ingestSave.save} saving={ingestSave.saving} saved={ingestSave.saved} error={ingestSave.error}>
          <Field label="Ingest method" hint="HTTP POST is recommended; requires no firewall changes">
            <SelectInput
              value={str('ingest_method', 'http')}
              onChange={v => set('ingest_method', v)}
              options={[
                { value: 'http', label: 'HTTP POST (recommended)' },
                { value: 'udp', label: 'Direct UDP' },
                { value: 'both', label: 'Both' },
              ]}
            />
          </Field>
          <Field label="Ingest token" hint="Bearer token required for HTTP POST endpoint. Leave blank to show current (masked).">
            <TextInput
              value={str('ingest_token')}
              onChange={v => set('ingest_token', v)}
              placeholder="Enter new token to change…"
              secret
              mono
            />
          </Field>
          <Field label="HTTP port" hint="Port pktFlow listens on">
            <NumberInput value={num('ingest_http_port', 8080)} onChange={v => set('ingest_http_port', v)} min={1} max={65535} />
          </Field>
          <Field label="UDP NetFlow port">
            <NumberInput value={num('ingest_udp_port_netflow', 2055)} onChange={v => set('ingest_udp_port_netflow', v)} min={1} max={65535} />
          </Field>
          <Field label="UDP sFlow port">
            <NumberInput value={num('ingest_udp_port_sflow', 6343)} onChange={v => set('ingest_udp_port_sflow', v)} min={1} max={65535} />
          </Field>
          <Field label="Allowed source IPs" hint="Comma-separated IPs or CIDRs. Empty = allow all.">
            <TextInput
              value={Array.isArray(settings['allowed_hosts']) ? (settings['allowed_hosts'] as string[]).join(', ') : ''}
              onChange={v => set('allowed_hosts', v.split(',').map(s => s.trim()).filter(Boolean))}
              placeholder="10.20.30.11, 10.20.30.181"
              mono
            />
          </Field>
          <Field label="Migration mode" hint="Forward a copy of all received flows to the old O2 sink during cutover">
            <Toggle value={bool('migration_mode')} onChange={v => set('migration_mode', v)} />
          </Field>
          {bool('migration_mode') && (
            <Field label="O2 forward URL">
              <TextInput
                value={str('migration_o2_url')}
                onChange={v => set('migration_o2_url', v)}
                placeholder="http://10.20.30.5:5080/api/default/medical_netflow/_json"
                mono
              />
            </Field>
          )}
        </Section>
      )}

      {/* Auth */}
      {tab === 'auth' && (
        <Section title="Authentication" onSave={authSave.save} saving={authSave.saving} saved={authSave.saved} error={authSave.error}>
          <Field label="Local auth" hint="Username/password login using local accounts">
            <Toggle value={bool('auth_local_enabled', true)} onChange={v => set('auth_local_enabled', v)} />
          </Field>
          <Field label="Session timeout">
            <div className="flex items-center gap-3">
              <NumberInput value={num('session_timeout_minutes', 480)} onChange={v => set('session_timeout_minutes', v)} min={5} max={10080} />
              <span className="text-sm text-gray-400">minutes</span>
            </div>
          </Field>

          <div className="pt-4 pb-2">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Okta OIDC SSO
              <Phase5Badge />
            </p>
          </div>
          <Field label="Enable Okta SSO">
            <Toggle value={bool('auth_okta_enabled')} onChange={v => set('auth_okta_enabled', v)} />
          </Field>
          {bool('auth_okta_enabled') && (
            <>
              <Field label="Issuer URL" hint="e.g. https://okta.example.com">
                <TextInput value={str('okta_issuer')} onChange={v => set('okta_issuer', v)} placeholder="https://yourorg.okta.com" mono />
              </Field>
              <Field label="Client ID">
                <TextInput value={str('okta_client_id')} onChange={v => set('okta_client_id', v)} mono />
              </Field>
              <Field label="Client Secret">
                <TextInput value={str('okta_client_secret')} onChange={v => set('okta_client_secret', v)} secret mono />
              </Field>
              <Field label="Redirect URI" hint="Must match your Okta app configuration">
                <TextInput
                  value={str('okta_redirect_uri')}
                  onChange={v => set('okta_redirect_uri', v)}
                  placeholder={`${str('base_url')}/auth/okta/callback`}
                  mono
                />
              </Field>
            </>
          )}
        </Section>
      )}

      {/* Notifications */}
      {tab === 'notifications' && (
        <Section title="Notifications" onSave={notifySave.save} saving={notifySave.saving} saved={notifySave.saved} error={notifySave.error}>
          {/* Slack */}
          <div className="pt-2 pb-1">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Slack</p>
          </div>
          <Field label="Enable Slack">
            <Toggle value={bool('notify_slack_enabled')} onChange={v => set('notify_slack_enabled', v)} />
          </Field>
          {bool('notify_slack_enabled') && (
            <>
              <Field label="Webhook URL">
                <TextInput value={str('notify_slack_webhook_url')} onChange={v => set('notify_slack_webhook_url', v)} placeholder="https://hooks.slack.com/services/…" secret mono />
              </Field>
              <Field label="Channel" hint="Override channel (optional)">
                <TextInput value={str('notify_slack_channel', '#alerts')} onChange={v => set('notify_slack_channel', v)} placeholder="#alerts" />
              </Field>
            </>
          )}

          {/* Email — Phase 5 */}
          <div className="pt-4 pb-1">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Email (SMTP) <Phase5Badge />
            </p>
          </div>
          <Field label="Enable email">
            <Toggle value={bool('notify_email_enabled')} onChange={v => set('notify_email_enabled', v)} />
          </Field>
          {bool('notify_email_enabled') && (
            <>
              <Field label="SMTP host">
                <TextInput value={str('notify_email_smtp_host')} onChange={v => set('notify_email_smtp_host', v)} placeholder="smtp.yourorg.com" mono />
              </Field>
              <Field label="SMTP port">
                <NumberInput value={num('notify_email_smtp_port', 587)} onChange={v => set('notify_email_smtp_port', v)} min={1} max={65535} />
              </Field>
              <Field label="Use TLS">
                <Toggle value={bool('notify_email_smtp_tls', true)} onChange={v => set('notify_email_smtp_tls', v)} />
              </Field>
              <Field label="Username">
                <TextInput value={str('notify_email_username')} onChange={v => set('notify_email_username', v)} mono />
              </Field>
              <Field label="Password">
                <TextInput value={str('notify_email_password')} onChange={v => set('notify_email_password', v)} secret />
              </Field>
              <Field label="From address">
                <TextInput value={str('notify_email_from')} onChange={v => set('notify_email_from', v)} placeholder="pktflow@yourorg.com" />
              </Field>
              <Field label="Default to" hint="Comma-separated email addresses">
                <TextInput
                  value={Array.isArray(settings['notify_email_default_to']) ? (settings['notify_email_default_to'] as string[]).join(', ') : ''}
                  onChange={v => set('notify_email_default_to', v.split(',').map(s => s.trim()).filter(Boolean))}
                  placeholder="noc@yourorg.com, security@yourorg.com"
                />
              </Field>
            </>
          )}

          {/* PagerDuty — Phase 5 */}
          <div className="pt-4 pb-1">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              PagerDuty <Phase5Badge />
            </p>
          </div>
          <Field label="Enable PagerDuty">
            <Toggle value={bool('notify_pagerduty_enabled')} onChange={v => set('notify_pagerduty_enabled', v)} />
          </Field>
          {bool('notify_pagerduty_enabled') && (
            <Field label="Integration key" hint="Events API v2 integration key">
              <TextInput value={str('notify_pagerduty_integration_key')} onChange={v => set('notify_pagerduty_integration_key', v)} secret mono />
            </Field>
          )}

          {/* Webhook — Phase 5 */}
          <div className="pt-4 pb-1">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Webhook <Phase5Badge />
            </p>
          </div>
          <Field label="Enable webhook">
            <Toggle value={bool('notify_webhook_enabled')} onChange={v => set('notify_webhook_enabled', v)} />
          </Field>
          {bool('notify_webhook_enabled') && (
            <>
              <Field label="URL">
                <TextInput value={str('notify_webhook_url')} onChange={v => set('notify_webhook_url', v)} placeholder="https://yourservice.com/pktflow-alert" mono />
              </Field>
              <Field label="Method">
                <SelectInput
                  value={str('notify_webhook_method', 'POST')}
                  onChange={v => set('notify_webhook_method', v)}
                  options={[{ value: 'POST', label: 'POST' }, { value: 'PUT', label: 'PUT' }]}
                />
              </Field>
              <Field label="Payload template" hint="Jinja2 template; available vars: alert_name, message, severity, fired_at">
                <textarea
                  value={str('notify_webhook_payload_template')}
                  onChange={e => set('notify_webhook_payload_template', e.target.value)}
                  rows={4}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </Field>
            </>
          )}
        </Section>
      )}

      {/* Devices tab — redirect to full devices management */}
      {tab === 'devices' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
          <p className="text-white font-medium mb-2">Device Management</p>
          <p className="text-sm text-gray-400 mb-4">
            Add, edit, and remove NetFlow samplers. Devices define how samplers are named and
            which source IPs are allowed to submit flows.
          </p>
          <DevicesTab />
        </div>
      )}
    </div>
  )
}

// ── Inline devices management ─────────────────────────────────────────────────
interface Device { id: number; ip: string; name: string; site: string; notes: string; allowed: boolean }

function DevicesTab() {
  const [devices, setDevices]   = useState<Device[]>([])
  const [editing, setEditing]   = useState<Device | null>(null)
  const [adding, setAdding]     = useState(false)
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState('')

  const EMPTY: Device = { id: 0, ip: '', name: '', site: '', notes: '', allowed: true }

  const load = async () => setDevices(await api.getDevices())
  useEffect(() => { load() }, [])

  const save = async (d: Device) => {
    setSaving(true)
    setError('')
    try {
      const body = { ip: d.ip, name: d.name, site: d.site, notes: d.notes, allowed: d.allowed }
      if (d.id) {
        await api.updateDevice(d.id, body)
      } else {
        await api.createDevice(body)
      }
      setEditing(null)
      setAdding(false)
      await load()
    } catch (e: any) {
      setError(e.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const del = async (id: number) => {
    if (!confirm('Remove this device?')) return
    await api.deleteDevice(id)
    await load()
  }

  const DeviceForm = ({ d }: { d: Device }) => {
    const [form, setForm] = useState<Device>(d)
    const f = <K extends keyof Device>(k: K, v: Device[K]) => setForm(x => ({ ...x, [k]: v }))
    return (
      <tr>
        <td colSpan={7} className="px-4 py-4 bg-gray-800/50">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            {([['IP', 'ip', '192.168.1.1'], ['Name', 'name', 'Core Switch'], ['Site', 'site', 'medical']] as const).map(([label, key, ph]) => (
              <div key={key}>
                <label className="block text-xs text-gray-400 mb-1">{label}</label>
                <input
                  value={form[key] as string}
                  onChange={e => f(key, e.target.value)}
                  placeholder={ph}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            ))}
            <div className="flex items-end gap-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Allowed</label>
                <Toggle value={form.allowed} onChange={v => f('allowed', v)} />
              </div>
            </div>
          </div>
          {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
          <div className="flex gap-2">
            <button onClick={() => save(form)} disabled={saving} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs rounded px-3 py-1.5">
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => { setEditing(null); setAdding(false) }} className="text-gray-400 hover:text-white text-xs border border-gray-700 rounded px-3 py-1.5">
              Cancel
            </button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <div className="text-left">
      <div className="flex justify-end mb-3">
        <button onClick={() => { setAdding(true); setEditing(null) }} className="bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg px-4 py-2">
          + Add device
        </button>
      </div>
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              {['IP', 'Name', 'Site', 'Allowed', 'Notes', ''].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-400">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {adding && <DeviceForm d={EMPTY} />}
            {devices.map(d => (
              <>
                {editing?.id === d.id ? (
                  <DeviceForm key={`edit-${d.id}`} d={d} />
                ) : (
                  <tr key={d.id} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-3 font-mono text-sm text-blue-300">{d.ip}</td>
                    <td className="px-4 py-3 text-white">{d.name}</td>
                    <td className="px-4 py-3 text-gray-400">{d.site}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded ${d.allowed ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                        {d.allowed ? 'Allowed' : 'Blocked'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{d.notes}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-3">
                        <button onClick={() => { setEditing(d); setAdding(false) }} className="text-xs text-gray-500 hover:text-blue-400 transition-colors">Edit</button>
                        <button onClick={() => del(d.id)} className="text-xs text-gray-500 hover:text-red-400 transition-colors">Remove</button>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
            {devices.length === 0 && !adding && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-500">No devices yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
