import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, DeviceSummary, User, UserIn, SslStatus, NatMapping, NatMappingIn, TrafficRule, TrafficRuleIn, Site, SiteIn, LineStyle, LineStyleIn, UserApiKey, Integration, IntegrationInput } from '../api/client'
import { useAutoRefresh } from '../store/autoRefresh'
import { useAuth } from '../store/auth'
import HelpButton from '../components/HelpButton'
import Pagination from '../components/Pagination'
import { copyToClipboard } from '../utils/clipboard'

// ── Generic helpers ────────────────────────────────────────────────────────────
type Settings = Record<string, unknown>

// Shared row cap for the four Geo Map tables (Sites, NAT Mappings, Traffic
// Rules, Line Style Catalog) — each paginates independently with its own
// Pagination control, not one pager for the whole Settings page.
const GEO_TABLE_PAGE_SIZE = 10

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-4 items-start py-4 border-b border-gray-800 last:border-0">
      <div>
        <p className="text-sm font-medium text-white">{label}</p>
        {hint && <p className="text-xs text-white mt-0.5">{hint}</p>}
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

// ── Snapshot files vary per backup (ClickHouse export can fail/be disabled),
// so the checkbox set is derived from what's actually in that snapshot ──
function SnapshotRestoreRow({ snapshot, onRestored }: {
  snapshot: { name: string; path: string; size_bytes: number; files: string[] }
  onRestored: (name: string, result: Record<string, string>) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set(snapshot.files))
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (f: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(f)) next.delete(f); else next.add(f)
      return next
    })
  }

  const restore = async () => {
    if (selected.size === 0) return
    const which = selected.size === snapshot.files.length ? 'all files' : Array.from(selected).join(', ')
    if (!window.confirm(`Restore ${which} from ${snapshot.name}?\n\nThis overwrites current data and cannot be undone.`)) return
    setRunning(true)
    setError(null)
    try {
      const result = await api.restoreSnapshot(snapshot.name, Array.from(selected))
      onRestored(snapshot.name, result)
      setExpanded(false)
    } catch (e: any) {
      setError(e.message || 'Restore failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="text-xs text-white">
      <div className="flex items-center gap-3">
        <span className="font-mono">{snapshot.name}</span>
        <span className="text-white">{(snapshot.size_bytes / 1024 / 1024).toFixed(1)} MB</span>
        <span className="text-white">{snapshot.files.join(', ')}</span>
        <button onClick={() => setExpanded(v => !v)} className="text-blue-400 hover:text-blue-300 underline">
          {expanded ? 'Cancel' : 'Restore…'}
        </button>
      </div>
      {expanded && (
        <div className="mt-2 mb-3 ml-4 space-y-2 bg-gray-800/60 rounded-lg p-3">
          <p className="text-white">Choose which files to restore:</p>
          <div className="flex flex-wrap gap-4">
            {snapshot.files.map(f => (
              <label key={f} className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={selected.has(f)} onChange={() => toggle(f)} className="accent-amber-600" />
                <span className="font-mono">{f}</span>
              </label>
            ))}
          </div>
          <button onClick={restore} disabled={running || selected.size === 0}
            className="bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-xs rounded-lg px-3 py-1.5 transition-colors">
            {running ? 'Restoring…' : 'Restore Selected'}
          </button>
          {error && <p className="text-red-400 mt-1">{error}</p>}
        </div>
      )}
    </div>
  )
}

function RestartServiceRow() {
  const [state, setState] = useState<'idle' | 'restarting' | 'done' | 'error'>('idle')

  const restart = async () => {
    if (state === 'restarting') return
    setState('restarting')
    try {
      await api.restartService()
      setState('done')
      // After a few seconds, show reconnecting state until page reload
      setTimeout(() => setState('idle'), 8000)
    } catch {
      setState('error')
      setTimeout(() => setState('idle'), 4000)
    }
  }

  return (
    <div className="grid grid-cols-3 gap-4 items-start py-4 border-b border-gray-800">
      <div>
        <p className="text-sm font-medium text-white">Restart Service</p>
        <p className="text-xs text-white mt-0.5">Apply backend changes or recover from errors</p>
      </div>
      <div className="col-span-2 flex items-center gap-3">
        <button
          onClick={restart}
          disabled={state === 'restarting'}
          className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-white text-white text-sm font-medium rounded-lg transition-colors"
        >
          {state === 'restarting' ? 'Restarting…' : 'Restart Service'}
        </button>
        {state === 'done' && (
          <span className="text-sm text-amber-400">Service is restarting — reload the page in ~5 seconds</span>
        )}
        {state === 'error' && (
          <span className="text-sm text-red-400">Restart failed — check server logs</span>
        )}
      </div>
    </div>
  )
}

// ── Port field — lives in config.yaml, not the SQLite-backed settings; value
// is lifted to the parent so it saves through the General tab's one Save button ──
function PortField({ value, onChange, loaded }: { value: number; onChange: (v: number) => void; loaded: boolean }) {
  return (
    <Field label="Port" hint="Port the app listens on. Requires a service restart — the browser will need to follow the app to the new port/URL afterward.">
      {!loaded ? (
        <p className="text-xs text-white">Loading…</p>
      ) : (
        <NumberInput value={value} onChange={onChange} min={1} max={65535} />
      )}
    </Field>
  )
}

// ── Section wrapper with Save ─────────────────────────────────────────────────
function Section({
  title, help, children, onSave, saving, saved, error,
}: {
  title: string
  help?: { title: string; content: ReactNode }
  children: React.ReactNode
  onSave: () => Promise<void>
  saving: boolean
  saved: boolean
  error: string
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-800 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {help && <HelpButton title={help.title}>{help.content}</HelpButton>}
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

function SendTestButton({ channel }: { channel: string }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'sent' | 'failed' | 'skipped'>('idle')
  const [detail, setDetail] = useState('')

  const run = async () => {
    setStatus('loading')
    setDetail('')
    try {
      const res = await api.testNotification(channel)
      setStatus(res.status as 'sent' | 'failed' | 'skipped')
      setDetail(res.detail || '')
    } catch (e) {
      setStatus('failed')
      setDetail(String(e))
    }
  }

  return (
    <div className="flex items-center gap-3 mt-2 mb-1">
      <button
        onClick={run}
        disabled={status === 'loading'}
        className="px-3 py-1.5 text-xs rounded-lg border border-gray-600 bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {status === 'loading' ? 'Sending…' : 'Send Test'}
      </button>
      {status === 'sent'    && <span className="text-xs text-green-400">✓ Sent{detail ? ` — ${detail}` : ''}</span>}
      {status === 'skipped' && <span className="text-xs text-yellow-400">⚠ Skipped — {detail}</span>}
      {status === 'failed'  && <span className="text-xs text-red-400">✗ Failed — {detail}</span>}
    </div>
  )
}

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

// ── Drag-and-drop cert/key textarea ──────────────────────────────────────────
function CertTextarea({ value, onChange, rows = 4, placeholder = 'MIIDp…', secret = false }: {
  value: string; onChange: (v: string) => void; rows?: number; placeholder?: string; secret?: boolean
}) {
  const [dragging, setDragging] = useState(false)
  const [revealed, setRevealed] = useState(false)

  const stripPem = (raw: string) =>
    raw
      .replace(/-----BEGIN[^-]+-----/g, '')
      .replace(/-----END[^-]+-----/g, '')
      .replace(/\s+/g, '')

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = reader.result as string
      onChange(stripPem(text))
      setRevealed(false)
    }
    reader.readAsText(file)
  }

  // When secret=true and a value is stored, show only a status indicator — no reveal
  if (secret && value && !revealed) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-green-400 font-mono">
          ✓ Certificate saved
        </div>
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="text-xs text-blue-400 hover:text-blue-300 whitespace-nowrap px-2 py-1 border border-gray-700 rounded-lg bg-gray-800"
        >
          Replace
        </button>
        <button
          type="button"
          onClick={() => onChange('')}
          className="text-xs text-red-400 hover:text-red-300 whitespace-nowrap px-2 py-1 border border-gray-700 rounded-lg bg-gray-800"
        >
          Clear
        </button>
      </div>
    )
  }

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`relative rounded-lg transition-colors ${dragging ? 'ring-2 ring-blue-400 bg-blue-950/30' : ''}`}
    >
      {secret && revealed && (
        <div className="flex justify-end mb-1">
          <button type="button" onClick={() => setRevealed(false)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
        </div>
      )}
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono resize-y"
      />
      {dragging && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg pointer-events-none">
          <p className="text-blue-300 text-sm font-medium bg-gray-900/80 px-3 py-1 rounded">Drop to import</p>
        </div>
      )}
      <p className="text-xs text-gray-600 mt-1">Paste content or drag &amp; drop a .pem / .crt / .cer file</p>
    </div>
  )
}

// ── SAML metadata paste box ───────────────────────────────────────────────────
function MetadataPasteBox({ onParsed }: {
  onParsed: (r: { entity_id: string; sso_url: string; cert: string }) => void
}) {
  const [xml, setXml]       = useState('')
  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle')
  const [msg, setMsg]       = useState('')

  const handleChange = (raw: string) => {
    setXml(raw)
    if (!raw.trim()) { setStatus('idle'); setMsg(''); return }
    const result = parseIdpMetadata(raw)
    if (result.error) {
      setStatus('error')
      setMsg(result.error)
    } else {
      onParsed(result)
      setStatus('ok')
      setMsg('Entity ID, SSO URL, and certificate populated below.')
    }
  }

  return (
    <div className="space-y-1.5">
      <textarea
        value={xml}
        onChange={e => handleChange(e.target.value)}
        rows={5}
        placeholder={'<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" …>'}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono resize-y"
      />
      {status === 'ok'    && <p className="text-xs text-emerald-400">✓ {msg}</p>}
      {status === 'error' && <p className="text-xs text-red-400">✗ {msg}</p>}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
type TabId = 'general' | 'security' | 'data' | 'notifications' | 'apikeys' | 'devices' | 'vpnmappings' | 'ingest'

const TABS: Array<{ id: TabId; label: string; adminOnly?: boolean; gapBefore?: boolean }> = [
  { id: 'general',       label: 'General' },
  { id: 'security',      label: 'Security' },
  { id: 'data',          label: 'Data' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'apikeys',       label: 'User Keys' },
  { id: 'devices',       label: 'Sources', gapBefore: true },
  { id: 'vpnmappings',   label: 'Geo Map',    adminOnly: true },
  { id: 'ingest',        label: 'Ingest' },
]

// ── Security tab — its own left-hand vertical tab strip ──────────────────────
type SecurityTabId = 'users' | 'auth' | 'suite' | 'ai' | 'ssl'
const SECURITY_TABS: Array<{ id: SecurityTabId; label: string; adminOnly?: boolean }> = [
  { id: 'users', label: 'Users', adminOnly: true },
  { id: 'auth',  label: 'Auth' },
  { id: 'suite', label: 'Suite Integration' },
  { id: 'ai',    label: 'AI Assistant' },
  { id: 'ssl',   label: 'SSL / TLS' },
]

// ── Data tab — its own left-hand vertical tab strip ───────────────────────────
type DataTabId = 'storage' | 'backups'
const DATA_TABS: Array<{ id: DataTabId; label: string }> = [
  { id: 'storage', label: 'Storage' },
  { id: 'backups', label: 'Backups' },
]

// ── SAML IdP metadata parser ──────────────────────────────────────────────────
function parseIdpMetadata(xml: string): {
  entity_id: string; sso_url: string; cert: string; error?: string
} {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.querySelector('parsererror')) return { entity_id: '', sso_url: '', cert: '', error: 'Invalid XML — check the metadata and try again.' }

    const root = doc.querySelector('EntityDescriptor') ?? doc.documentElement
    const entity_id = root.getAttribute('entityID') ?? ''

    // Prefer HTTP-Redirect binding; fall back to any SSO service
    let sso_url = ''
    const ssoNodes = Array.from(doc.querySelectorAll('SingleSignOnService'))
    const redirect = ssoNodes.find(n => (n.getAttribute('Binding') ?? '').includes('HTTP-Redirect'))
    sso_url = (redirect ?? ssoNodes[0])?.getAttribute('Location') ?? ''

    // Prefer signing key; fall back to any X509Certificate
    let cert = ''
    const keyDescs = Array.from(doc.querySelectorAll('KeyDescriptor'))
    const signingKd = keyDescs.find(kd => !kd.getAttribute('use') || kd.getAttribute('use') === 'signing')
    const x509El = signingKd?.querySelector('X509Certificate') ?? doc.querySelector('X509Certificate')
    cert = x509El?.textContent?.replace(/\s+/g, '') ?? ''

    if (!entity_id && !sso_url && !cert)
      return { entity_id: '', sso_url: '', cert: '', error: 'No SAML IdP data found in this XML.' }

    return { entity_id, sso_url, cert }
  } catch {
    return { entity_id: '', sso_url: '', cert: '', error: 'Failed to parse XML.' }
  }
}


// ── Sibling pkt apps (outbound) ─────────────────────────────────────────────────
// Named connections to sibling pkt* apps pktflow pulls data from — currently
// just pktIPAM, for the internal-IP lookup in IpLink.tsx. Ported from
// pktIPAM's own "sibling pkt apps" pattern (there: pktIPAM -> pktsnmp).
const APP_LABELS: Record<string, string> = {
  pktipam: 'pktIPAM',
}

interface IntegrationFormState {
  name: string; app_name: string; base_url: string; suite_token: string
}

const EMPTY_INTEGRATION: IntegrationFormState = { name: '', app_name: 'pktipam', base_url: '', suite_token: '' }

function IntegrationFormModal({ integration, onClose, onSaved }: {
  integration: Integration | null; onClose: () => void; onSaved: () => void
}) {
  const editing = !!integration
  const [form, setForm] = useState<IntegrationFormState>(
    editing ? { name: integration!.name, app_name: integration!.app_name, base_url: integration!.base_url, suite_token: '' }
            : { ...EMPTY_INTEGRATION }
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const setF = <K extends keyof IntegrationFormState>(k: K, v: IntegrationFormState[K]) => setForm(f => ({ ...f, [k]: v }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      if (editing) {
        const body: Partial<IntegrationInput> = { name: form.name, base_url: form.base_url }
        if (form.suite_token) body.suite_token = form.suite_token
        await api.updateIntegration(integration!.id, body)
      } else {
        await api.createIntegration(form)
      }
      onSaved()
    } catch (e: any) {
      setError(e.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const inp = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500'

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white mb-5">{editing ? `Edit — ${integration!.name}` : 'Add pktIPAM Connection'}</h2>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs text-white block mb-1">Name *</label>
            <input value={form.name} onChange={e => setF('name', e.target.value)} required autoFocus
              placeholder="e.g. Main pktIPAM" className={inp} />
          </div>
          <div>
            <label className="text-xs text-white block mb-1">Base URL *</label>
            <input value={form.base_url} onChange={e => setF('base_url', e.target.value)} required
              placeholder="http://aiserver:8761" className={inp} />
          </div>
          <div>
            <label className="text-xs text-white block mb-1">Suite Token {editing ? '(leave blank to keep)' : '*'}</label>
            <input type="password" value={form.suite_token} onChange={e => setF('suite_token', e.target.value)}
              required={!editing} placeholder="From that pktIPAM's Settings -> Integrations -> Suite Integration" className={inp} />
          </div>
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-white">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50">
              {saving ? 'Saving…' : (editing ? 'Save Changes' : 'Add Connection')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function SiblingIntegrations() {
  const [items, setItems] = useState<Integration[]>([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState<'new' | Integration | null>(null)
  const [confirm, setConfirm] = useState<Integration | null>(null)
  const [testResult, setTestResult] = useState<Record<number, string>>({})
  const [error, setError] = useState('')

  const load = () => {
    setLoading(true)
    api.getIntegrations().then(setItems).catch(e => setError(e.message)).finally(() => setLoading(false))
  }
  useEffect(load, [])

  const del = async (i: Integration) => {
    try {
      await api.deleteIntegration(i.id)
      setConfirm(null)
      load()
    } catch (e: any) {
      setError(e.message)
    }
  }

  const test = async (i: Integration) => {
    try {
      const result = await api.testIntegration(i.id)
      setTestResult(prev => ({ ...prev, [i.id]: result.healthy ? `OK — ${result.detail}` : `Failed — ${result.detail}` }))
    } catch (e: any) {
      setTestResult(prev => ({ ...prev, [i.id]: `Failed — ${e.message}` }))
    }
    load()
  }

  if (loading) return <p className="text-xs text-white animate-pulse py-3">Loading…</p>

  return (
    <div className="space-y-3 py-3">
      {error && (
        <div className="bg-red-900/30 border border-red-700/50 text-red-400 text-sm rounded-lg px-4 py-2 flex items-center justify-between">
          {error}<button onClick={() => setError('')} className="ml-4 text-red-600 hover:text-red-400">✕</button>
        </div>
      )}

      {items.map(i => (
        <div key={i.id} className="bg-gray-800/40 border border-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-sm font-medium text-white">{i.name}</p>
              <p className="text-xs text-white">{APP_LABELS[i.app_name] ?? i.app_name} · {i.base_url || 'no URL set'}</p>
            </div>
            <span className={i.health_status === 'ok' ? 'text-xs text-emerald-400' : 'text-xs text-white'}>{i.health_status}</span>
          </div>
          <div className="flex items-center gap-3 mt-2">
            <button onClick={() => test(i)} className="text-xs text-white border border-gray-700 rounded-lg px-3 py-1.5 hover:bg-gray-800">Test Connection</button>
            <button onClick={() => setModal(i)} className="text-xs text-white hover:text-blue-400">Edit</button>
            <button onClick={() => setConfirm(i)} className="text-xs text-white hover:text-red-400">Delete</button>
            {testResult[i.id] && <span className="text-xs text-white">{testResult[i.id]}</span>}
          </div>
        </div>
      ))}
      {items.length === 0 && <p className="text-sm text-white py-2">No pktIPAM connections yet.</p>}

      <button onClick={() => setModal('new')}
        className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors">
        <span className="text-base leading-none">+</span> Add Connection
      </button>

      {modal !== null && (
        <IntegrationFormModal integration={modal === 'new' ? null : modal} onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }} />
      )}

      {confirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setConfirm(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <h3 className="text-white font-semibold mb-2">Delete connection?</h3>
            <p className="text-white text-sm mb-5">
              Remove <strong className="text-white">{confirm.name}</strong>? Internal-IP lookups will fall back to
              any other enabled pktIPAM connection, or stop working if this was the only one.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirm(null)} className="px-4 py-2 text-sm text-white">Cancel</button>
              <button onClick={() => del(confirm)} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
// ── End Sibling pkt apps ──────────────────────────────────────────────────────

// ── Suite Integration component ───────────────────────────────────────────────
function PktHubTokenDisplay() {
  const [token, setToken]           = useState('')
  const [revealed, setRevealed]     = useState(false)
  const [copied, setCopied]         = useState(false)
  const [loaded, setLoaded]         = useState(false)
  const [regenerating, setRegen]    = useState(false)

  const regenerate = async () => {
    if (!confirm('Generate a new token?\n\nThe current token will stop working immediately.\nYou will need to re-register this app in pktHub with the new token.')) return
    setRegen(true)
    try {
      const r = await fetch('/api/suite/token/regenerate', { method: 'POST', credentials: 'include' })
      const d = await r.json()
      if (d.suite_token) { setToken(d.suite_token); setRevealed(true) }
    } catch {}
    setRegen(false)
  }

  useEffect(() => {
    fetch('/api/suite/token', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { setToken(d.suite_token || ''); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [])

  const masked = token
    ? token.slice(0, 6) + '\u2022'.repeat(28) + token.slice(-4)
    : ''

  return (
    <>
      <div className="grid grid-cols-3 gap-4 items-start py-3 border-b border-gray-800">
        <div>
          <p className="text-sm font-medium text-white">Suite Token</p>
          <p className="text-xs text-gray-500 mt-0.5">Copy to pktHub when registering this app</p>
        </div>
        <div className="col-span-2">
          {!loaded && <p className="text-xs text-gray-500 animate-pulse">Loading…</p>}
          {loaded && !token && (
            <p className="text-xs text-yellow-400">No token set — visit this page again after restarting the service.</p>
          )}
          {loaded && token && (
            <div className="flex items-center gap-2 flex-wrap">
              <code className="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs font-mono text-gray-200 break-all">
                {revealed ? token : masked}
              </code>
              <button
                onClick={() => setRevealed(v => !v)}
                className="px-2 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 rounded-lg bg-gray-800 whitespace-nowrap"
              >
                {revealed ? 'Hide' : 'Reveal'}
              </button>
              <button
                onClick={async () => {
                  const ok = await copyToClipboard(token)
                  if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000) }
                }}
                className="px-3 py-1.5 text-xs font-medium text-white rounded-lg whitespace-nowrap transition-colors"
                style={{ background: copied ? '#16a34a' : '#2563eb' }}
              >
                {copied ? '\u2713 Copied' : 'Copy Token'}
              </button>
              <button
                onClick={regenerate}
                disabled={regenerating}
                title="Generate a new token — you must re-register in pktHub after"
                className="px-2 py-1.5 text-xs font-medium text-red-400 hover:text-red-300 border border-red-800/60 hover:border-red-600 rounded-lg whitespace-nowrap disabled:opacity-40 transition-colors"
              >
                {regenerating ? '\u2026' : 'Regen'}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4 items-start py-3">
        <div>
          <p className="text-sm font-medium text-white">How to register</p>
        </div>
        <div className="col-span-2 space-y-1 text-xs text-gray-400">
          <p>1. Copy the token above.</p>
          <p>2. In pktHub &#8594; App Manager &#8594; Register App, enter this app&#39;s URL and paste the token.</p>
          <p>3. pktHub will open this app through its proxy with users automatically signed in.</p>
          <p className="text-gray-500 mt-2 text-xs">&#9888; The token is permanent — it does <em>not</em> change on restart. Use <strong className="text-gray-400">Regenerate</strong> to revoke current access and issue a new token (re-register in pktHub afterwards).</p>
        </div>
      </div>
    </>
  )
}
// ── End Suite Integration ─────────────────────────────────────────────────────


export default function Settings() {
  const { user: me }          = useAuth()
  const isAdmin               = me?.role === 'admin'
  const [searchParams]        = useSearchParams()
  const [tab, setTab]         = useState<TabId>((searchParams.get('tab') as TabId) || 'general')
  const [securityTab, setSecurityTab] = useState<SecurityTabId>(isAdmin ? 'users' : 'auth')
  const [dataTab, setDataTab] = useState<DataTabId>('storage')
  // Deep-link from an "Unknown sampler" alert event — pre-fills the
  // add-device form on the Devices tab; the user still decides the rest of
  // the fields and clicks Save themselves.
  const registerIp            = searchParams.get('register_ip') || ''
  const [settings, setSettings] = useState<Settings>({})
  const [loading, setLoading] = useState(true)
  // Tracks whether the user has made unsaved edits.
  // silentLoad skips the refresh while dirty so in-progress form work isn't overwritten.
  const dirtyRef = useRef(false)

  const load = async () => {
    setLoading(true)
    try { setSettings(await api.getSettings()) } finally {
      setLoading(false)
      dirtyRef.current = false
    }
  }
  // Silent refresh — updates settings without triggering the loading spinner.
  // Skipped entirely when the user has unsaved changes.
  const silentLoad = async () => {
    if (dirtyRef.current) return
    try { setSettings(await api.getSettings()) } catch {}
  }
  useEffect(() => { load() }, [])
  // Background poll: re-fetch settings every 60s so the page stays current
  // if another admin saves changes or a CLI update is made to the DB.
  useEffect(() => {
    const t = setInterval(silentLoad, 60_000)
    return () => clearInterval(t)
  }, [])

  const set = (key: string, value: unknown) => {
    dirtyRef.current = true
    setSettings(s => ({ ...s, [key]: value }))
  }

  const str  = (k: string, fallback = '') => (settings[k] as string) ?? fallback
  const num  = (k: string, fallback = 0)  => (settings[k] as number) ?? fallback
  const bool = (k: string, fallback = false) => (settings[k] as boolean) ?? fallback

  // Don't show the "remotely managed" lockout when pktHub itself is the one
  // viewing this page (via the proxy embed) — only for a real direct visit.
  const hubManaged = bool('hub_settings_managed', false) && me?.authProvider !== 'suite'

  // Per-tab save helpers
  // General tab's Port field lives in config.yaml (not the SQLite settings
  // blob) so it needs its own fetch, but saves through the same one button.
  const [portValue, setPortValue]   = useState(0)
  const [portLoaded, setPortLoaded] = useState(false)
  useEffect(() => {
    api.getPort().then(r => setPortValue(r.port)).catch(() => {}).finally(() => setPortLoaded(true))
  }, [])

  const [generalSaving, setGeneralSaving] = useState(false)
  const [generalSaved, setGeneralSaved]   = useState(false)
  const [generalError, setGeneralError]   = useState('')

  const saveGeneral = async () => {
    if (portValue < 1 || portValue > 65535) { setGeneralError('Enter a port between 1 and 65535'); return }
    setGeneralSaving(true); setGeneralSaved(false); setGeneralError('')
    try {
      const subset: Settings = {}
      for (const k of ['app_name', 'base_url', 'timezone']) if (k in settings) subset[k] = settings[k]
      await api.bulkUpdateSettings(subset)
      await api.setPort(portValue)
      await load()
      setGeneralSaved(true)
      setTimeout(() => setGeneralSaved(false), 3000)
    } catch (e: any) {
      setGeneralError(e.message || 'Save failed')
    } finally {
      setGeneralSaving(false)
    }
  }

  const aiAssistantSave = useSave(['anthropic_api_key', 'ai_model'], settings, load)
  const storageSave = useSave([
    'storage_backend', 'retention_days_raw', 'retention_days_hourly', 'alert_event_retention_days',
  ], settings, load)
  const backupSave = useSave([
    'backup_enabled', 'backup_interval_hours', 'backup_rotation_count', 'backup_path', 'backup_include_clickhouse',
  ], settings, load)
  const [testConnRunning, setTestConnRunning] = useState(false)
  const [testConnResult, setTestConnResult]   = useState<{ ok: boolean; message: string } | null>(null)
  const [cleanupRunning, setCleanupRunning] = useState(false)
  const [cleanupResult, setCleanupResult]   = useState<string | null>(null)
  const [exportRunning, setExportRunning]   = useState(false)
  const [exportError, setExportError]       = useState<string | null>(null)
  const [importFile, setImportFile]         = useState<File | null>(null)
  const [importRunning, setImportRunning]   = useState(false)
  const [importResult, setImportResult]     = useState<Record<string, string> | null>(null)
  const [importError, setImportError]       = useState<string | null>(null)
  const [backupRunning, setBackupRunning]   = useState(false)
  const [backupResult, setBackupResult]     = useState<string | null>(null)
  const [backups, setBackups]               = useState<Array<{ name: string; path: string; size_bytes: number; files: string[] }>>([])
  const [backupsLoaded, setBackupsLoaded]   = useState(false)
  const [snapshotRestoreResult, setSnapshotRestoreResult] = useState<{ name: string; result: Record<string, string> } | null>(null)
  const ALL_BUNDLE_FILES = ['pktflow.db', 'config.yaml', 'flows.csv.gz']
  const [importFiles, setImportFiles]       = useState<Set<string>>(new Set(ALL_BUNDLE_FILES))

  const testConnection = async () => {
    setTestConnRunning(true)
    setTestConnResult(null)
    try {
      const r = await api.testStorageConnection()
      setTestConnResult({ ok: r.ok, message: r.message })
    } catch (e: any) {
      setTestConnResult({ ok: false, message: e.message || 'Request failed' })
    } finally {
      setTestConnRunning(false)
    }
  }

  const runCleanup = async () => {
    setCleanupRunning(true)
    setCleanupResult(null)
    try {
      const r = await api.runCleanup()
      const parts: string[] = []
      if (r.flows_eligible > 0)
        parts.push(`${r.flows_eligible.toLocaleString()} flows queued for deletion`)
      else
        parts.push('No flows beyond retention threshold')
      if (r.hourly_eligible > 0)
        parts.push(`${r.hourly_eligible.toLocaleString()} hourly rollup rows queued`)
      if (r.alert_events_deleted > 0)
        parts.push(`${r.alert_events_deleted} alert events purged`)
      setCleanupResult(parts.join(' · '))
    } catch (e: any) {
      setCleanupResult(`Error: ${e.message}`)
    } finally {
      setCleanupRunning(false)
    }
  }
  const runBackupNow = async () => {
    setBackupRunning(true)
    setBackupResult(null)
    try {
      const r = await api.runBackupNow()
      setBackupResult(`Saved to ${r.path} — ${r.files.join(', ')}`)
      const list = await api.listBackups()
      setBackups(list)
      setBackupsLoaded(true)
    } catch (e: any) {
      setBackupResult(`Error: ${e.message}`)
    } finally {
      setBackupRunning(false)
    }
  }

  const loadBackups = async () => {
    try {
      const list = await api.listBackups()
      setBackups(list)
      setBackupsLoaded(true)
    } catch { /* ignore */ }
  }

  const runImport = async () => {
    if (!importFile) return
    setImportRunning(true)
    setImportResult(null)
    setImportError(null)
    try {
      const result = await api.importBundle(importFile, Array.from(importFiles))
      setImportResult(result)
    } catch (e: any) {
      setImportError(e.message || 'Import failed')
    } finally {
      setImportRunning(false)
    }
  }

  const runExport = async () => {
    setExportRunning(true)
    setExportError(null)
    try {
      const { blob, filename } = await api.exportConfig()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e: any) {
      setExportError(e.message || 'Export failed')
    } finally {
      setExportRunning(false)
    }
  }

  const ingestSave  = useSave([
    'ingest_method', 'ingest_token', 'ingest_http_port',
    'ingest_udp_port_netflow', 'ingest_udp_port_sflow',
    'allowed_hosts', 'ws_stream_raw_flows', 'ws_max_raw_flows',
  ], settings, load)
  const authSave = useSave([
    'auth_local_enabled', 'session_timeout_minutes',
    'okta_saml_enabled', 'okta_saml_idp_entity_id', 'okta_saml_idp_sso_url',
    'okta_saml_idp_cert', 'okta_saml_sp_entity_id', 'okta_saml_sp_cert', 'okta_saml_sp_key',
  ], settings, load)
  const notifySave = useSave([
    'notify_slack_enabled', 'notify_slack_webhook_url', 'notify_slack_channel',
    'notify_email_enabled', 'notify_email_smtp_host', 'notify_email_smtp_port',
    'notify_email_smtp_tls', 'notify_email_username', 'notify_email_password',
    'notify_email_from', 'notify_email_default_to',
    'notify_pagerduty_enabled', 'notify_pagerduty_integration_key',
    'notify_webhook_enabled', 'notify_webhook_url',
    'notify_webhook_method', 'notify_webhook_payload_template',
    'notify_tracecat_enabled', 'notify_tracecat_webhook_url', 'notify_tracecat_api_token',
  ], settings, load)
  const lucidSave = useSave(['lucid_api_token'], settings, load)

  const { tick } = useAutoRefresh()
  useEffect(() => { if (tick > 0) silentLoad() }, [tick])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-white">
        <p className="text-sm">Loading settings…</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-white">pktFlow - Settings</h1>

      {/* Tab bar */}
      <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit overflow-x-auto">
        {TABS.filter(t => !t.adminOnly || isAdmin).map(t => (
          <Fragment key={t.id}>
            {t.gapBefore && <div className="w-px self-stretch bg-gray-700 mx-2" />}
            <button
              onClick={() => setTab(t.id)}
              className={`text-sm px-4 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
                tab === t.id ? 'bg-gray-700 text-white' : 'text-white hover:text-white'
              }`}
            >
              {t.label}
            </button>
          </Fragment>
        ))}
      </div>

      {hubManaged && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-amber-800/40 bg-amber-900/20 text-amber-300 text-sm">
          <span className="font-semibold">Remotely Managed</span>
          <span className="text-amber-300/80">— this app is registered with pktHub, which now controls Settings. Make changes from pktHub instead.</span>
        </div>
      )}

      <div className={hubManaged ? 'opacity-40 pointer-events-none select-none' : undefined}>

      {/* General */}
      {tab === 'general' && (
        <Section title="General" onSave={saveGeneral} saving={generalSaving} saved={generalSaved} error={generalError}
          help={{
            title: 'General — How It Works',
            content: <>
              <p><span className="text-gray-300 font-medium">Base URL</span> isn't cosmetic — it's baked into things other systems call back to: the SAML ACS/metadata URLs shown on the Auth tab, and any links posted in Slack/Email/webhook notifications. Set it to the actual externally-reachable address before configuring SSO or notifications, or those integrations will point at the wrong place.</p>
              <p><span className="text-gray-300 font-medium">Port</span> only takes effect after a restart. Changing it moves the app to a new URL; the browser won't follow automatically.</p>
            </>,
          }}
        >
          <Field label="App name" hint="Displayed in browser tab and header">
            <TextInput value={str('app_name', 'pktFlow')} onChange={v => set('app_name', v)} />
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
          <PortField value={portValue} onChange={setPortValue} loaded={portLoaded} />
          <Field label="Base URL" hint="Used for redirect URIs and notification links">
            <TextInput value={str('base_url')} onChange={v => set('base_url', v)} placeholder="http://<APP_SERVER_IP>:8080" />
          </Field>
          <RestartServiceRow />
        </Section>
      )}

      {/* Security */}
      {tab === 'security' && (
        <div className="flex gap-4 items-start">
          <div className="flex flex-col gap-1.5 w-48 flex-shrink-0">
            {SECURITY_TABS.filter(st => !st.adminOnly || isAdmin).map(st => (
              <button
                key={st.id}
                onClick={() => setSecurityTab(st.id)}
                className={`text-sm px-4 py-2 rounded-lg border text-left whitespace-nowrap transition-colors ${
                  securityTab === st.id
                    ? 'bg-gray-800 border-blue-500 text-white'
                    : 'bg-gray-900 border-gray-800 text-white hover:border-gray-600'
                }`}
              >
                {st.label}
              </button>
            ))}
          </div>

          <div className="flex-1 min-w-0">
            {securityTab === 'users' && isAdmin && <UsersTab />}

            {securityTab === 'auth' && (
              <Section title="Authentication" onSave={authSave.save} saving={authSave.saving} saved={authSave.saved} error={authSave.error}
                help={{
                  title: 'Authentication — How It Works',
                  content: <>
                    <p><span className="text-gray-300 font-medium">Local auth</span> and <span className="text-gray-300 font-medium">SAML SSO</span> aren't mutually exclusive — both can be on at once, letting some users log in with a local password while others come through Okta. Turning Local auth off forces everyone through SSO.</p>
                    <p>SAML users are <span className="text-gray-300 font-medium">auto-provisioned</span> on first successful login — there's no separate "create user" step for SSO accounts.</p>
                    <p>Setting this up: paste Okta's IdP metadata XML into the box above to auto-fill the IdP fields, then register the <span className="text-gray-300 font-medium">ACS URL</span> shown here as the Single Sign-On URL in your Okta app. Both the ACS URL and the SP metadata link are derived from <span className="text-gray-300 font-medium">Base URL</span> on the General tab — set that correctly first, or SSO will register against the wrong address.</p>
                    <p className="text-gray-500">Okta OIDC is not a separate option here — it was deliberately dropped in favor of SAML 2.0, which already covers Okta SSO.</p>
                  </>,
                }}
              >
                <Field label="Local auth" hint="Username/password login using local accounts">
                  <Toggle value={bool('auth_local_enabled', true)} onChange={v => set('auth_local_enabled', v)} />
                </Field>
                <Field label="Session timeout">
                  <div className="flex items-center gap-3">
                    <NumberInput value={num('session_timeout_minutes', 480)} onChange={v => set('session_timeout_minutes', v)} min={5} max={10080} />
                    <span className="text-sm text-white">minutes</span>
                  </div>
                </Field>

                <div className="pt-4 pb-2">
                  <p className="text-xs font-semibold text-white uppercase tracking-wider">Okta SAML 2.0 SSO</p>
                </div>
                <Field label="Enable SAML SSO">
                  <Toggle value={bool('okta_saml_enabled')} onChange={v => set('okta_saml_enabled', v)} />
                </Field>
                {bool('okta_saml_enabled') && (
                  <>
                    {/* ── Metadata paste helper ── */}
                    <Field label="Paste IdP Metadata XML" hint="Paste the full XML from Okta → Sign On → Identity Provider metadata. Fields below will auto-fill.">
                      <MetadataPasteBox onParsed={(r) => {
                        if (r.entity_id) set('okta_saml_idp_entity_id', r.entity_id)
                        if (r.sso_url)   set('okta_saml_idp_sso_url', r.sso_url)
                        if (r.cert)      set('okta_saml_idp_cert', r.cert)
                      }} />
                    </Field>

                    <Field label="IdP Entity ID" hint="From Okta metadata: Identity Provider Issuer">
                      <TextInput value={str('okta_saml_idp_entity_id')} onChange={v => set('okta_saml_idp_entity_id', v)} placeholder="http://www.okta.com/..." mono />
                    </Field>
                    <Field label="IdP SSO URL" hint="From Okta metadata: Identity Provider Single Sign-On URL">
                      <TextInput value={str('okta_saml_idp_sso_url')} onChange={v => set('okta_saml_idp_sso_url', v)} placeholder="https://yourorg.okta.com/app/.../sso/saml" mono />
                    </Field>
                    <Field label="IdP X.509 Certificate" hint="PEM headers are stripped automatically">
                      <CertTextarea value={str('okta_saml_idp_cert')} onChange={v => set('okta_saml_idp_cert', v)} rows={4} secret />
                    </Field>
                    <Field label="SP Entity ID" hint="Leave blank to use the auto-generated metadata URL">
                      <TextInput value={str('okta_saml_sp_entity_id')} onChange={v => set('okta_saml_sp_entity_id', v)} placeholder={`${str('base_url')}/api/auth/saml/metadata`} mono />
                    </Field>
                    <Field label="ACS URL (read-only)" hint="Register this URL as the Single Sign-On URL in your Okta app">
                      <div className="flex items-center gap-2">
                        <input
                          readOnly
                          value={`${str('base_url')}/api/auth/saml/callback`}
                          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-400 font-mono cursor-default"
                        />
                        <a
                          href={`${str('base_url')}/api/auth/saml/metadata`}
                          className="text-xs text-blue-400 hover:text-blue-300 whitespace-nowrap"
                        >
                          View SP metadata ↗
                        </a>
                      </div>
                    </Field>
                    <Field label="SP Certificate" hint="Optional: for signed authentication requests">
                      <CertTextarea value={str('okta_saml_sp_cert')} onChange={v => set('okta_saml_sp_cert', v)} rows={3} placeholder="Leave blank if not signing requests" secret />
                    </Field>
                    <Field label="SP Private Key" hint="Optional: private key for signing requests (kept secret)">
                      <CertTextarea value={str('okta_saml_sp_key')} onChange={v => set('okta_saml_sp_key', v)} rows={3} placeholder="Leave blank if not signing requests" secret />
                    </Field>
                  </>
                )}
              </Section>
            )}

            {securityTab === 'suite' && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-4">
                <div className="flex items-center gap-2 mb-4">
                  <h2 className="text-sm font-semibold text-white">Suite Integration</h2>
                  <HelpButton title="Suite Integration — How It Works">
                    <p>One-directional discovery: copy the Suite Token here into pktHub's App Manager when registering this app, so pktHub can proxy into it with users already signed in. Regenerating the token immediately revokes the old one — you'll need to re-register in pktHub afterward.</p>
                  </HelpButton>
                </div>
                <PktHubTokenDisplay />
              </div>
            )}

            {securityTab === 'suite' && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-4">
                <div className="flex items-center gap-2 mb-4">
                  <h2 className="text-sm font-semibold text-white">Sibling pkt Apps</h2>
                  <HelpButton title="Sibling pkt Apps — How It Works">
                    <p>The other direction from the Suite Token above: pktflow calling into pktIPAM to look up internal (private) IP addresses — subnet, hostname, DHCP lease, DNS records — the same way it already looks up external IPs via ipinfo.io/AbuseIPDB.</p>
                    <p className="mt-2">In pktIPAM, go to Settings &#8594; Integrations &#8594; Suite Integration and copy its Suite Token, then add a connection here with pktIPAM's base URL and that token. You can add more than one named pktIPAM connection; the first enabled one is used for lookups.</p>
                  </HelpButton>
                </div>
                <SiblingIntegrations />
              </div>
            )}

            {securityTab === 'ai' && (
              <Section title="AI Assistant" onSave={aiAssistantSave.save} saving={aiAssistantSave.saving} saved={aiAssistantSave.saved} error={aiAssistantSave.error}
                help={{
                  title: 'AI Assistant — How It Works',
                  content: <>
                    <p><span className="text-gray-300 font-medium">AI Assistant</span> needs its own Anthropic API key (from console.anthropic.com — separate from a Claude Enterprise seat) before the in-app chat panel will do anything. Haiku is the default model: fastest and cheapest for flow-context questions; switch to Sonnet or Opus only if you need deeper reasoning over larger flow contexts.</p>
                  </>,
                }}
              >
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
                      { value: 'claude-sonnet-5', label: 'Claude Sonnet (balanced)' },
                      { value: 'claude-opus-4-8', label: 'Claude Opus (most capable)' },
                    ]}
                  />
                </Field>
              </Section>
            )}

            {securityTab === 'ssl' && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-4">
                <div className="flex items-center gap-2 mb-4">
                  <h2 className="text-sm font-semibold text-white">SSL / TLS</h2>
                  <HelpButton title="SSL/TLS — How It Works">
                    <p>Accepts either a combined PFX/P12 file or a separate PEM cert+key pair, drag-and-drop or click to browse — the running service auto-detects and loads whichever was uploaded at startup.</p>
                  </HelpButton>
                </div>
                <SslPanel />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Data */}
      {tab === 'data' && (
        <div className="flex gap-4 items-start">
          <div className="flex flex-col gap-1.5 w-48 flex-shrink-0">
            {DATA_TABS.map(dt => (
              <button
                key={dt.id}
                onClick={() => setDataTab(dt.id)}
                className={`text-sm px-4 py-2 rounded-lg border text-left whitespace-nowrap transition-colors ${
                  dataTab === dt.id
                    ? 'bg-gray-800 border-blue-500 text-white'
                    : 'bg-gray-900 border-gray-800 text-white hover:border-gray-600'
                }`}
              >
                {dt.label}
              </button>
            ))}
          </div>

          <div className="flex-1 min-w-0">
      {dataTab === 'storage' && (
        <Section title="Storage" onSave={storageSave.save} saving={storageSave.saving} saved={storageSave.saved} error={storageSave.error}
          help={{
            title: 'Storage — How It Works',
            content: <>
              <p>Switching <span className="text-gray-300 font-medium">Backend</span> requires a service restart to actually take effect — the running process picks its storage driver once at startup, so saving this field alone won't move any data or change what's being queried.</p>
              <p><span className="text-amber-500 font-medium">DuckDB has real gaps:</span> several alert rule types (baselines, elephant-flow/threshold/port-scan detail queries) deliberately raise "not implemented" under DuckDB rather than silently returning wrong results — core paths (search, top talkers/ports, protocol distribution, topology) work fine, but those specific alert rules won't fire. ClickHouse has no such gaps.</p>
              <p>Retention days apply per-tier — raw flow records are usually kept far shorter than hourly rollups, since rollups are what long-range Analytics charts read from. <span className="text-gray-300 font-medium">Manual cleanup</span> applies the current thresholds immediately instead of waiting for the next scheduled pass; on ClickHouse the actual deletion is a queued TTL mutation, so it may not be instant even after this returns.</p>
            </>,
          }}
        >
          <Field label="Backend" hint="ClickHouse is the production default, installed automatically by install.sh; DuckDB is embedded and needs no separate service, but has feature gaps (see below). A service restart is required after changing this setting.">
            <SelectInput
              value={str('storage_backend', 'clickhouse')}
              onChange={v => set('storage_backend', v)}
              options={[
                { value: 'clickhouse', label: 'ClickHouse (default)' },
                { value: 'duckdb', label: 'DuckDB (embedded, no external service)' },
              ]}
            />
          </Field>
          <Field label="Test connection" hint="Verify the backend is reachable and the flows table exists">
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={testConnection}
                disabled={testConnRunning}
                className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 transition-colors"
              >
                {testConnRunning ? 'Testing…' : 'Test Connection'}
              </button>
              {testConnResult && (
                <span className={`text-xs ${testConnResult.ok ? 'text-green-400' : 'text-red-400'}`}>
                  {testConnResult.ok ? '✓ ' : '✗ '}{testConnResult.message}
                </span>
              )}
            </div>
          </Field>
          <Field label="Raw flow retention" hint="Days to keep individual flow records">
            <div className="flex items-center gap-3">
              <NumberInput value={num('retention_days_raw', 90)} onChange={v => set('retention_days_raw', v)} min={1} max={3650} />
              <span className="text-sm text-white">days</span>
            </div>
          </Field>
          <Field label="Hourly rollup retention" hint="Days to keep per-hour aggregated data">
            <div className="flex items-center gap-3">
              <NumberInput value={num('retention_days_hourly', 365)} onChange={v => set('retention_days_hourly', v)} min={1} max={3650} />
              <span className="text-sm text-white">days</span>
            </div>
          </Field>
          <Field label="Alert event retention" hint="Days to keep fired alert events and notification logs before auto-purge">
            <div className="flex items-center gap-3">
              <NumberInput value={num('alert_event_retention_days', 90)} onChange={v => set('alert_event_retention_days', v)} min={1} max={3650} />
              <span className="text-sm text-white">days</span>
            </div>
          </Field>
          <Field label="Manual cleanup" hint="Immediately apply current retention settings — ClickHouse TTL mutation is queued asynchronously">
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={runCleanup}
                disabled={cleanupRunning}
                className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 transition-colors"
              >
                {cleanupRunning ? 'Running…' : 'Run Cleanup Now'}
              </button>
              {cleanupResult && (
                <span className={`text-xs ${cleanupResult.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
                  {cleanupResult}
                </span>
              )}
            </div>
          </Field>
        </Section>
      )}

      {/* Backup */}
      {dataTab === 'backups' && (
        <Section title="Backup" onSave={backupSave.save} saving={backupSave.saving} saved={backupSave.saved} error={backupSave.error}
          help={{
            title: 'Backup — How It Works',
            content: <>
              <p>A backup always includes the SQLite database (settings, devices, users, alert rules) and <code className="text-gray-400">config.yaml</code>. <span className="text-gray-300 font-medium">Include ClickHouse flows</span> additionally exports full flow history as CSV into the same snapshot — worth disabling if you only care about configuration, since flow history is usually the largest part by far.</p>
              <p><span className="text-gray-300 font-medium">Rotation count</span> caps how many snapshots (scheduled or manual) are kept on disk — the oldest is deleted automatically once you exceed it. Auto backup and Manual backup share the same rotation pool.</p>
              <p><span className="text-gray-300 font-medium">Export bundle</span> is a one-off download (a <code className="text-gray-400">.tar.gz</code>) you take with you, separate from the rotation-managed snapshots above. <span className="text-amber-500 font-medium">Restore always requires a service restart</span> afterward for any config changes in the bundle to actually apply — the UI will keep showing pre-restore settings until then.</p>
            </>,
          }}
        >
          <Field label="Auto backup" hint="Run a scheduled backup on the app server server at the configured interval">
            <Toggle value={bool('backup_enabled')} onChange={v => set('backup_enabled', v)} />
          </Field>
          <Field label="Interval" hint="Hours between automatic backup runs">
            <div className="flex items-center gap-3">
              <NumberInput value={num('backup_interval_hours', 24)} onChange={v => set('backup_interval_hours', v)} min={1} max={720} />
              <span className="text-sm text-white">hours</span>
            </div>
          </Field>
          <Field label="Rotation count" hint="Number of snapshots to keep — oldest deleted when exceeded">
            <NumberInput value={num('backup_rotation_count', 5)} onChange={v => set('backup_rotation_count', v)} min={1} max={100} />
          </Field>
          <Field label="Backup path" hint="Directory on app server where snapshots are stored">
            <TextInput value={str('backup_path', '/opt/pktflow_backups')} onChange={v => set('backup_path', v)} mono />
          </Field>
          <Field label="Include ClickHouse flows" hint="Export full flow history into each snapshot (can be large)">
            <Toggle value={bool('backup_include_clickhouse', true)} onChange={v => set('backup_include_clickhouse', v)} />
          </Field>
          <Field label="Manual backup" hint="Trigger a backup run immediately using current settings">
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={runBackupNow}
                  disabled={backupRunning}
                  className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 transition-colors"
                >
                  {backupRunning ? 'Running…' : 'Run Backup Now'}
                </button>
                {!backupsLoaded && !backupRunning && (
                  <button onClick={loadBackups} className="text-xs text-white hover:text-white underline">
                    Show snapshots
                  </button>
                )}
              </div>
              {backupResult && (
                <p className={`text-xs ${backupResult.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
                  {backupResult}
                </p>
              )}
              {backupsLoaded && (
                <div className="space-y-1">
                  {backups.length === 0 ? (
                    <p className="text-xs text-white">No snapshots found.</p>
                  ) : backups.map(b => (
                    <SnapshotRestoreRow key={b.name} snapshot={b} onRestored={(name, result) => setSnapshotRestoreResult({ name, result })} />
                  ))}
                </div>
              )}
              {snapshotRestoreResult && (
                <div className="text-xs space-y-1 bg-gray-800/60 rounded-lg p-3">
                  <p className="text-white">Restored from {snapshotRestoreResult.name}:</p>
                  {Object.entries(snapshotRestoreResult.result).map(([k, v]) => (
                    <p key={k}>
                      <span className="text-white">{k}:</span>{' '}
                      <span className={v.startsWith('error') || v.startsWith('not found') ? 'text-red-400' : 'text-green-400'}>{v}</span>
                    </p>
                  ))}
                  <p className="text-amber-400 mt-1">Restart the service to apply any config changes.</p>
                </div>
              )}
            </div>
          </Field>
          <Field label="Export bundle" hint="Download pktflow.db + config.yaml + ClickHouse flow history as a .tar.gz. Large datasets may take a minute to generate.">
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={runExport}
                disabled={exportRunning}
                className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 transition-colors"
              >
                {exportRunning ? 'Generating…' : 'Download Export'}
              </button>
              {exportError && (
                <span className="text-xs text-red-400">{exportError}</span>
              )}
            </div>
          </Field>
          <Field label="Restore from bundle" hint="Upload a pktflow export .tar.gz to restore SQLite, config, and flow history. Restart service after restore for config changes to take effect.">
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <label className="bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg px-4 py-2 transition-colors cursor-pointer">
                  {importFile ? importFile.name : 'Choose .tar.gz…'}
                  <input
                    type="file"
                    accept=".tar.gz,.tgz"
                    className="hidden"
                    onChange={e => {
                      setImportFile(e.target.files?.[0] ?? null)
                      setImportResult(null)
                      setImportError(null)
                    }}
                  />
                </label>
                <button
                  onClick={runImport}
                  disabled={!importFile || importRunning || importFiles.size === 0}
                  className="bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 transition-colors"
                >
                  {importRunning ? 'Restoring…' : 'Restore'}
                </button>
              </div>
              <div className="flex flex-wrap gap-4 text-xs text-white">
                {ALL_BUNDLE_FILES.map(f => (
                  <label key={f} className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={importFiles.has(f)}
                      onChange={() => setImportFiles(prev => {
                        const next = new Set(prev)
                        if (next.has(f)) next.delete(f); else next.add(f)
                        return next
                      })}
                      className="accent-amber-600"
                    />
                    <span className="font-mono">{f}</span>
                  </label>
                ))}
              </div>
              {importError && (
                <p className="text-xs text-red-400">{importError}</p>
              )}
              {importResult && (
                <div className="text-xs space-y-1">
                  {Object.entries(importResult).map(([k, v]) => (
                    <p key={k}>
                      <span className="text-white capitalize">{k}:</span>{' '}
                      <span className={v.startsWith('error') ? 'text-red-400' : 'text-green-400'}>{v}</span>
                    </p>
                  ))}
                  <p className="text-amber-400 mt-1">Restart the service to apply any config changes.</p>
                </div>
              )}
            </div>
          </Field>
        </Section>
      )}
          </div>
        </div>
      )}

      {/* Ingest */}
      {tab === 'ingest' && (
        <Section title="Ingest" onSave={ingestSave.save} saving={ingestSave.saving} saved={ingestSave.saved} error={ingestSave.error}
          help={{
            title: 'Ingest — How It Works',
            content: <>
              <p><span className="text-gray-300 font-medium">HTTP POST</span> means one or more goflow2+Vector collector pipelines decode raw NetFlow/IPFIX/sFlow and push snake_case JSON batches to this app's <code className="text-gray-400">/api/ingest/flows</code> over HTTPS, authenticated by the Ingest token below. <span className="text-gray-300 font-medium">Direct UDP</span> skips the external collector and listens for raw NetFlow v5/v9/IPFIX/sFlow packets itself.</p>
              <p><span className="text-amber-500 font-medium">Changing Ingest method or either UDP port requires an actual service restart</span> to take effect — the UDP listener only starts or stops at process startup, so saving this form alone won't switch anything live.</p>
              <p>Regardless of ingest path, a flow is only stored if its sampler IP is <span className="text-gray-300 font-medium">present and enabled in the device registry</span> (Sources tab) — this settings page controls transport, not what's allowed through.</p>
              <p><span className="text-gray-300 font-medium">Stream raw flows</span> pushes every ingest batch to connected browsers over WebSocket for the live dashboard counter — harmless at normal volume, but worth disabling or capping (Max flows per push) on very high-throughput links.</p>
            </>,
          }}
        >
          <Field label="Ingest method" hint="HTTP POST is recommended; requires no firewall changes. A service restart is required after changing this setting — the UDP listener only starts/stops at process startup.">
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
            <NumberInput value={num('ingest_http_port', 8766)} onChange={v => set('ingest_http_port', v)} min={1} max={65535} />
          </Field>
          <Field label="UDP NetFlow port" hint="Requires a service restart to take effect">
            <NumberInput value={num('ingest_udp_port_netflow', 2055)} onChange={v => set('ingest_udp_port_netflow', v)} min={1} max={65535} />
          </Field>
          <Field label="UDP sFlow port">
            <NumberInput value={num('ingest_udp_port_sflow', 6343)} onChange={v => set('ingest_udp_port_sflow', v)} min={1} max={65535} />
          </Field>
          <Field label="Allowed source IPs" hint="Comma-separated IPs or CIDRs. Empty = allow all.">
            <TextInput
              value={Array.isArray(settings['allowed_hosts']) ? (settings['allowed_hosts'] as string[]).join(', ') : ''}
              onChange={v => set('allowed_hosts', v.split(',').map(s => s.trim()).filter(Boolean))}
              placeholder="<COLLECTOR_IP_1>, <COLLECTOR_IP_2>"
              mono
            />
          </Field>

          <div className="pt-4 pb-1">
            <p className="text-xs font-semibold text-white uppercase tracking-wider">
              WebSocket Live Push
            </p>
          </div>
          <Field label="Stream raw flows" hint="Push each ingested flow batch over WebSocket to connected browsers. Disable if bandwidth is a concern.">
            <Toggle value={bool('ws_stream_raw_flows')} onChange={v => set('ws_stream_raw_flows', v)} />
          </Field>
          {bool('ws_stream_raw_flows') && (
            <Field label="Max flows per push" hint="Cap the number of flow records sent in each WebSocket message (1–1000)">
              <div className="flex items-center gap-3">
                <NumberInput value={num('ws_max_raw_flows', 100)} onChange={v => set('ws_max_raw_flows', v)} min={1} max={1000} />
                <span className="text-sm text-white">flows</span>
              </div>
            </Field>
          )}
        </Section>
      )}

      {/* Notifications */}
      {tab === 'notifications' && (
        <Section title="Notifications" onSave={notifySave.save} saving={notifySave.saving} saved={notifySave.saved} error={notifySave.error}
          help={{
            title: 'Notifications — How It Works',
            content: <>
              <p>These five channels — Slack, Email, PagerDuty, generic Webhook, and TraceCat SOAR — are what an <span className="text-gray-300 font-medium">Alert rule</span> (Alerts page) actually dispatches to when it fires. Enabling a channel here doesn't send anything by itself; it just makes the channel available for alert rules to use.</p>
              <p><span className="text-gray-300 font-medium">Send Test</span> is a real dispatch, not a dry run — it posts to Slack, sends an actual SMTP message, fires a PagerDuty event, etc., using whatever credentials are currently filled in above (even if unsaved). Use it to confirm a webhook URL or SMTP login actually works before relying on it during a real alert.</p>
              <p><span className="text-gray-300 font-medium">Webhook payload template</span> is Jinja2 — reference <code className="text-gray-400">alert_name</code>, <code className="text-gray-400">message</code>, <code className="text-gray-400">severity</code>, and <code className="text-gray-400">fired_at</code> to shape the JSON body sent to your endpoint.</p>
            </>,
          }}
        >
          {/* Slack */}
          <div className="pt-2 pb-1">
            <p className="text-xs font-semibold text-white uppercase tracking-wider">Slack</p>
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
              <SendTestButton channel="slack" />
            </>
          )}

          {/* Email */}
          <div className="pt-4 pb-1">
            <p className="text-xs font-semibold text-white uppercase tracking-wider">Email (SMTP)</p>
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
              <SendTestButton channel="email" />
            </>
          )}

          {/* PagerDuty */}
          <div className="pt-4 pb-1">
            <p className="text-xs font-semibold text-white uppercase tracking-wider">PagerDuty</p>
          </div>
          <Field label="Enable PagerDuty">
            <Toggle value={bool('notify_pagerduty_enabled')} onChange={v => set('notify_pagerduty_enabled', v)} />
          </Field>
          {bool('notify_pagerduty_enabled') && (
            <>
              <Field label="Integration key" hint="Events API v2 integration key">
                <TextInput value={str('notify_pagerduty_integration_key')} onChange={v => set('notify_pagerduty_integration_key', v)} secret mono />
              </Field>
              <SendTestButton channel="pagerduty" />
            </>
          )}

          {/* Webhook */}
          <div className="pt-4 pb-1">
            <p className="text-xs font-semibold text-white uppercase tracking-wider">Webhook</p>
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
              <SendTestButton channel="webhook" />
            </>
          )}

          {/* TraceCat */}
          <div className="pt-2 pb-1">
            <p className="text-sm font-medium text-white">TraceCat SOAR</p>
          </div>
          <Field label="Enable TraceCat">
            <Toggle value={bool('notify_tracecat_enabled')} onChange={v => set('notify_tracecat_enabled', v)} />
          </Field>
          {bool('notify_tracecat_enabled') && (
            <>
              <Field label="Webhook URL" hint="Paste the workflow webhook URL from TraceCat → Workflow → Trigger">
                <TextInput value={str('notify_tracecat_webhook_url')} onChange={v => set('notify_tracecat_webhook_url', v)} placeholder="https://tracecat.yourorg.com/api/v1/webhooks/…" mono />
              </Field>
              <Field label="API token" hint="Bearer token for TraceCat API authentication (optional if webhook is public)">
                <TextInput value={str('notify_tracecat_api_token')} onChange={v => set('notify_tracecat_api_token', v)} secret />
              </Field>
              <SendTestButton channel="tracecat" />
            </>
          )}
        </Section>
      )}

      {/* Devices tab */}
      {tab === 'devices' && <DevicesTab prefillIp={registerIp} />}

      {/* Geo Map tab — admin only */}
      {tab === 'vpnmappings' && isAdmin && <GeoMapTab />}

      {/* User Keys tab — personal keys plus the app-wide Lucidchart token */}
      {tab === 'apikeys' && (
        <ApiKeysTab
          lucidToken={str('lucid_api_token')}
          onLucidChange={v => set('lucid_api_token', v)}
          lucidSave={lucidSave}
        />
      )}
      </div>
    </div>
  )
}

// ── SSL certificate upload ─────────────────────────────────────────────────────

function SslDropZone({ label, accept, file, onFile, dragging, onDrag }: {
  label: string; accept: string; file: File | null
  onFile: (f: File) => void; dragging: boolean; onDrag: (v: boolean) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div
      className={`flex-1 border-2 border-dashed rounded-xl p-5 flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors select-none ${
        dragging    ? 'border-blue-500 bg-blue-500/10'
        : file      ? 'border-green-600 bg-green-600/10'
        : 'border-gray-700 hover:border-gray-600'
      }`}
      onClick={() => inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); onDrag(true) }}
      onDragLeave={() => onDrag(false)}
      onDrop={e => { e.preventDefault(); onDrag(false); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}
    >
      <input ref={inputRef} type="file" accept={accept} className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
      {file ? (
        <>
          <svg className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
          <p className="text-xs font-medium text-green-400 text-center break-all">{file.name}</p>
          <p className="text-xs text-white">{(file.size / 1024).toFixed(1)} KB</p>
        </>
      ) : (
        <>
          <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
          </svg>
          <p className="text-xs font-medium text-white text-center">{label}</p>
          <p className="text-xs text-white">Drop or click to browse</p>
        </>
      )}
    </div>
  )
}

function SslPanel() {
  const [status, setStatus]       = useState<SslStatus | null>(null)
  const [mode, setMode]           = useState<'pem' | 'pfx'>('pfx')
  // PEM mode
  const [certFile, setCertFile]   = useState<File | null>(null)
  const [keyFile,  setKeyFile]    = useState<File | null>(null)
  const [certDrag, setCertDrag]   = useState(false)
  const [keyDrag,  setKeyDrag]    = useState(false)
  // PFX mode
  const [pfxFile,  setPfxFile]    = useState<File | null>(null)
  const [pfxDrag,  setPfxDrag]    = useState(false)
  const [passphrase, setPassphrase] = useState('')
  // Shared
  const [uploading, setUploading] = useState(false)
  const [removing,  setRemoving]  = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    api.getSslStatus().then(setStatus).catch(() => setStatus({ installed: false }))
  }, [])

  const uploadPem = async () => {
    if (!certFile || !keyFile) return
    setUploading(true); setMsg(null)
    try {
      const s = await api.uploadSsl(certFile, keyFile)
      setStatus(s); setCertFile(null); setKeyFile(null)
      setMsg({ ok: true, text: 'Certificate installed. Restart the service (General tab) to enable HTTPS.' })
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? 'Upload failed' })
    } finally { setUploading(false) }
  }

  const uploadPfx = async () => {
    if (!pfxFile || !passphrase) return
    setUploading(true); setMsg(null)
    try {
      const s = await api.uploadSslPfx(pfxFile, passphrase)
      setStatus(s); setPfxFile(null); setPassphrase('')
      setMsg({ ok: true, text: 'Certificate installed from PFX. Restart the service (General tab) to enable HTTPS.' })
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? 'Upload failed' })
    } finally { setUploading(false) }
  }

  const remove = async () => {
    setRemoving(true); setMsg(null)
    try {
      await api.deleteSsl()
      setStatus({ installed: false })
      setMsg({ ok: true, text: 'Certificate removed. Restart service to disable HTTPS.' })
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? 'Remove failed' })
    } finally { setRemoving(false) }
  }

  const daysLeft = status?.days_until_expiry ?? 9999
  const expColor = daysLeft < 0 ? 'text-red-400' : daysLeft < 30 ? 'text-yellow-400' : 'text-green-400'
  const expBadge = daysLeft < 0 ? 'Expired' : daysLeft < 30 ? `Expires in ${daysLeft}d` : `Valid · ${daysLeft}d left`

  const pemReady = !!(certFile && keyFile)
  const pfxReady = !!(pfxFile && passphrase)

  return (
    <div className="space-y-4">
      {/* Current cert status */}
      {status?.installed ? (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0"></span>
              <span className="text-sm font-medium text-white">Certificate installed</span>
            </div>
            <span className={`text-xs font-medium ${expColor}`}>{expBadge}</span>
          </div>
          {status.subject && <p className="text-xs text-white font-mono">{status.subject}</p>}
          {status.issuer  && <p className="text-xs text-white">Issued by: {status.issuer}</p>}
          {status.expires && <p className="text-xs text-white">Expires: {status.expires}</p>}
          {status.error   && <p className="text-xs text-red-400">Warning: {status.error}</p>}
          <button onClick={remove} disabled={removing}
            className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 pt-1">
            {removing ? 'Removing…' : '× Remove certificate'}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-white">
          <span className="w-2 h-2 rounded-full bg-gray-600 flex-shrink-0"></span>
          No certificate installed · running HTTP
        </div>
      )}

      {/* Mode toggle */}
      <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg p-1 w-fit">
        <button
          onClick={() => setMode('pfx')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${mode === 'pfx' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
          PFX / P12
        </button>
        <button
          onClick={() => setMode('pem')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${mode === 'pem' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
          PEM (cert + key)
        </button>
      </div>

      {mode === 'pfx' ? (
        /* ── PFX mode ── */
        <div className="space-y-3">
          <SslDropZone label="PFX / P12 file (.pfx, .p12)" accept=".pfx,.p12"
            file={pfxFile} onFile={setPfxFile} dragging={pfxDrag} onDrag={setPfxDrag} />
          <div>
            <label className="block text-xs text-gray-400 mb-1">Passphrase</label>
            <input
              type="password"
              value={passphrase}
              onChange={e => setPassphrase(e.target.value)}
              placeholder="PFX passphrase"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-center gap-3">
            <button onClick={uploadPfx} disabled={!pfxReady || uploading}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors">
              {uploading ? 'Uploading…' : 'Upload & Install'}
            </button>
            {!pfxReady && (
              <span className="text-xs text-gray-500">
                {!pfxFile ? 'Drop a PFX file above' : 'Enter the passphrase'}
              </span>
            )}
          </div>
        </div>
      ) : (
        /* ── PEM mode ── */
        <div className="space-y-3">
          <div className="flex gap-3">
            <SslDropZone label="Certificate (.crt / .pem)" accept=".crt,.pem,.cer"
              file={certFile} onFile={setCertFile} dragging={certDrag} onDrag={setCertDrag} />
            <SslDropZone label="Private Key (.key / .pem)" accept=".key,.pem"
              file={keyFile} onFile={setKeyFile} dragging={keyDrag} onDrag={setKeyDrag} />
          </div>
          <div className="flex items-center gap-3">
            <button onClick={uploadPem} disabled={!pemReady || uploading}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors">
              {uploading ? 'Uploading…' : 'Upload & Install'}
            </button>
            {!pemReady && (
              <span className="text-xs text-gray-500">Drop both cert and key files above</span>
            )}
          </div>
        </div>
      )}

      {msg && <p className={`text-xs ${msg.ok ? 'text-green-400' : 'text-red-400'}`}>{msg.text}</p>}

      <p className="text-xs text-gray-500 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 leading-relaxed">
        After uploading, restart the service from the <strong className="text-white">General</strong> tab.
        The service wrapper auto-detects cert files on startup — no additional config needed.
      </p>
    </div>
  )
}

// ── Devices tab — managed devices + live collector stats ──────────────────────
interface Device { id: number; ip: string; name: string; site: string; notes: string; allowed: boolean }

const STATUS_DOT: Record<string, string> = {
  online: 'bg-green-400', stale: 'bg-yellow-400', offline: 'bg-red-400',
}
const STATUS_TEXT: Record<string, string> = {
  online: 'text-green-400', stale: 'text-yellow-400', offline: 'text-red-400',
}

function samplerStatus(lastSeen: string | null | undefined): 'online' | 'stale' | 'offline' {
  if (!lastSeen) return 'offline'
  const ago = (Date.now() - new Date(lastSeen).getTime()) / 1000
  if (ago < 120) return 'online'
  if (ago < 600) return 'stale'
  return 'offline'
}

function fmtDevBytes(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB'
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB'
  return b + ' B'
}

function fmtRelative(ts: string | null | undefined): string {
  if (!ts) return '—'
  const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

// Defined at module scope (not inside DevicesTab) so its identity is stable
// across DevicesTab re-renders — the periodic device-summary/list polling
// updates DevicesTab's state every 15–30s, and a component defined inside a
// re-rendering parent gets a new function identity on every render, which
// makes React unmount + remount it (wiping whatever the user had typed).
function DeviceForm({ d, saving, error, onSave, onCancel }: {
  d: Device
  saving: boolean
  error: string
  onSave: (d: Device) => void
  onCancel: () => void
}) {
  const [form, setForm] = useState<Device>(d)
  const f = <K extends keyof Device>(k: K, v: Device[K]) => setForm(x => ({ ...x, [k]: v }))
  return (
    <tr>
      <td colSpan={8} className="px-4 py-4 bg-gray-800/50">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          {([['IP', 'ip', '192.168.1.1'], ['Name', 'name', 'Core Switch'], ['Site', 'site', 'site-a']] as const).map(([label, key, ph]) => (
            <div key={key}>
              <label className="block text-xs text-white mb-1">{label}</label>
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
              <label className="block text-xs text-white mb-1">Allowed</label>
              <Toggle value={form.allowed} onChange={v => f('allowed', v)} />
            </div>
          </div>
        </div>
        <div className="mb-3">
          <label className="block text-xs text-white mb-1">Notes</label>
          <input
            value={form.notes}
            onChange={e => f('notes', e.target.value)}
            placeholder="Optional notes"
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
        <div className="flex gap-2">
          <button onClick={() => onSave(form)} disabled={saving} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs rounded px-3 py-1.5">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onCancel} className="text-white hover:text-white text-xs border border-gray-700 rounded px-3 py-1.5">
            Cancel
          </button>
        </div>
      </td>
    </tr>
  )
}

function DevicesTab({ prefillIp = '' }: { prefillIp?: string }) {
  const [devices, setDevices]     = useState<Device[]>([])
  const [summaries, setSummaries] = useState<DeviceSummary[]>([])
  const [editing, setEditing]     = useState<Device | null>(null)
  const [adding, setAdding]       = useState(false)
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState('')
  const [csvImporting, setCsvImporting] = useState(false)
  const [csvResult, setCsvResult]       = useState<{ created: number; updated: number; skipped: number; errors: Array<{ row: number; reason: string }> } | null>(null)
  const [csvError, setCsvError]         = useState<string | null>(null)
  const [csvExporting, setCsvExporting] = useState(false)
  const [deviceFilter, setDeviceFilter] = useState('')
  const [unknownSamplers, setUnknownSamplers] = useState<Array<{ sampler_ip: string; flows_per_sec: number; last_seen: string }>>([])
  const [dismissedSamplers, setDismissedSamplers] = useState<Array<{ sampler_ip: string; dismissed_at: string }>>([])
  const [knownSites, setKnownSites] = useState<string[]>([])
  const [registeringIp, setRegisteringIp] = useState<string | null>(null)
  const [dismissedExpanded, setDismissedExpanded] = useState(false)

  const EMPTY: Device = { id: 0, ip: '', name: '', site: '', notes: '', allowed: true }

  // Deep-linked from an "Unknown sampler" alert event — open the add form
  // with just the IP filled in; the user decides everything else.
  useEffect(() => {
    if (prefillIp) {
      setEditing(null)
      setAdding(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillIp])

  const loadDevices   = async () => { try { setDevices(await api.getDevices()) } catch {} }
  const loadSummaries = async () => { try { setSummaries(await api.getDeviceSummaries()) } catch {} }
  const loadUnknown   = async () => {
    try {
      const [data, sites] = await Promise.all([api.getUnknownSamplers(), api.getDeviceSites()])
      setUnknownSamplers(data.unknown)
      setDismissedSamplers(data.dismissed)
      setKnownSites(sites)
    } catch {}
  }

  useEffect(() => {
    loadDevices()
    loadSummaries()
    loadUnknown()
    const t1 = setInterval(loadSummaries, 15_000)
    // Refresh device list + unknown samplers every 30s (new registrations, dismissals from another session)
    const t2 = setInterval(() => { loadDevices(); loadUnknown() }, 30_000)
    return () => { clearInterval(t1); clearInterval(t2) }
  }, [])

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
      await loadDevices()
    } catch (e: any) {
      setError(e.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const del = async (id: number) => {
    if (!confirm('Remove this device?')) return
    await api.deleteDevice(id)
    await loadDevices()
  }

  const dismiss = async (ip: string) => {
    try { await api.dismissSampler(ip); await loadUnknown() } catch {}
  }
  const reconsider = async (ip: string) => {
    try { await api.undismissSampler(ip); await loadUnknown() } catch {}
  }

  // Inline registration form for unknown samplers
  const InlineRegisterForm = ({ ip, onSaved, onCancel }: { ip: string; onSaved: () => void; onCancel: () => void }) => {
    const [name, setName] = useState('')
    const [site, setSite] = useState(knownSites[0] || '')
    const [customSite, setCustomSite] = useState('')
    const [saving, setSaving] = useState(false)
    const [err, setErr] = useState('')
    const effectiveSite = site === '__custom__' ? customSite : site
    const submit = async () => {
      setSaving(true); setErr('')
      try {
        await api.createDevice({ ip, name, site: effectiveSite, notes: '', allowed: true })
        await loadDevices()
        onSaved()
      } catch (e: any) { setErr(e.message || 'Failed to register') }
      finally { setSaving(false) }
    }
    return (
      <div className="mt-3 space-y-3 border-t border-gray-700 pt-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Core Router"
              className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Site</label>
            {knownSites.length > 0 ? (
              <select value={site} onChange={e => setSite(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                {knownSites.map(s => <option key={s} value={s}>{s}</option>)}
                <option value="__custom__">Custom…</option>
              </select>
            ) : (
              <input value={customSite} onChange={e => setCustomSite(e.target.value)} placeholder="site name"
                className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
            )}
            {site === '__custom__' && (
              <input value={customSite} onChange={e => setCustomSite(e.target.value)} placeholder="site name" className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
            )}
          </div>
        </div>
        {err && <p className="text-xs text-red-400">{err}</p>}
        <div className="flex gap-2">
          <button onClick={submit} disabled={saving}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs rounded px-3 py-1.5 transition-colors">
            {saving ? 'Saving…' : 'Register'}
          </button>
          <button onClick={onCancel}
            className="text-xs border border-gray-700 text-gray-400 hover:text-white rounded px-3 py-1.5 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    )
  }

  const handleCsvImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setCsvImporting(true)
    setCsvResult(null)
    setCsvError(null)
    try {
      const result = await api.importDevicesCsv(file)
      setCsvResult(result)
      await loadDevices()
    } catch (err: any) {
      setCsvError(err.message || 'Import failed')
    } finally {
      setCsvImporting(false)
    }
  }

  const handleCsvExport = async () => {
    setCsvExporting(true)
    try { await api.exportDevicesCsv() }
    catch (err: any) { setCsvError(err.message || 'Export failed') }
    finally { setCsvExporting(false) }
  }

  const downloadTemplate = () => {
    const csv = 'ip,name,site,notes,allowed\n192.168.1.1,Core Switch,site-a,Main distribution switch,true\n10.0.0.1,Edge Router,site-b,,true\n'
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'devices-template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  // Join: managed devices + live summaries keyed by IP
  const summaryMap = Object.fromEntries(summaries.map(s => [s.sampler_ip, s]))

  const cancelEdit = () => { setEditing(null); setAdding(false) }

  return (
    <div>
      {/* Unknown Samplers Panel */}
      {(unknownSamplers.length > 0 || dismissedSamplers.length > 0) && (
        <div className="mb-4 bg-gray-900 border border-amber-800/40 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-400 inline-block animate-pulse" />
            <p className="text-sm font-medium text-white">Unknown samplers</p>
            {unknownSamplers.length > 0 && (
              <span className="text-xs bg-amber-900/30 text-amber-400 border border-amber-700/40 rounded px-1.5 py-0.5">
                {unknownSamplers.length} need{unknownSamplers.length === 1 ? 's' : ''} review
              </span>
            )}
          </div>

          {unknownSamplers.length === 0 ? (
            <p className="px-4 py-3 text-sm text-gray-400">All active samplers are registered or dismissed.</p>
          ) : (
            <div className="divide-y divide-gray-800/50">
              {unknownSamplers.map(s => (
                <div key={s.sampler_ip} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-mono text-white">{s.sampler_ip}</p>
                      <p className="text-xs text-gray-400">
                        {s.flows_per_sec.toFixed(1)} flows/s · last seen {fmtRelative(s.last_seen)}
                      </p>
                    </div>
                    {registeringIp !== s.sampler_ip && (
                      <div className="flex gap-2 flex-shrink-0">
                        <button onClick={() => setRegisteringIp(s.sampler_ip)}
                          className="text-xs bg-blue-600 hover:bg-blue-500 text-white rounded px-3 py-1.5 transition-colors">
                          Register
                        </button>
                        <button onClick={() => dismiss(s.sampler_ip)}
                          className="text-xs border border-gray-700 text-gray-400 hover:text-white rounded px-3 py-1.5 transition-colors">
                          Dismiss
                        </button>
                      </div>
                    )}
                  </div>
                  {registeringIp === s.sampler_ip && (
                    <InlineRegisterForm
                      ip={s.sampler_ip}
                      onSaved={async () => { setRegisteringIp(null); await loadUnknown() }}
                      onCancel={() => setRegisteringIp(null)}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {dismissedSamplers.length > 0 && (
            <div className="border-t border-gray-800">
              <button
                onClick={() => setDismissedExpanded(!dismissedExpanded)}
                className="w-full px-4 py-2 flex items-center justify-between text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                <span>Dismissed ({dismissedSamplers.length})</span>
                <span>{dismissedExpanded ? '▲' : '▼'}</span>
              </button>
              {dismissedExpanded && (
                <div className="divide-y divide-gray-800/50 border-t border-gray-800">
                  {dismissedSamplers.map(s => (
                    <div key={s.sampler_ip} className="px-4 py-2 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-mono text-gray-400">{s.sampler_ip}</p>
                        <p className="text-xs text-gray-500">dismissed {fmtRelative(s.dismissed_at)}</p>
                      </div>
                      <button onClick={() => reconsider(s.sampler_ip)}
                        className="text-xs text-gray-400 hover:text-white transition-colors">
                        Reconsider
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 mb-1">
        <p className="text-sm font-semibold text-white">Device Registry</p>
        <HelpButton title="Device Registry — How It Works">
          <p>This is the <span className="text-gray-300 font-medium">ingest allowlist</span>, not just a labeling table — flows from a sampler IP that's absent here, or present but not marked Allowed, are dropped before storage entirely. They never reach the database, and won't show up unlabeled either; they simply don't exist as far as the rest of the app is concerned.</p>
          <p>The registry is <span className="text-gray-300 font-medium">warmed into memory at process startup</span>, so adding or enabling a device takes effect immediately without a restart — but if the service itself was just restarted, a brand-new sampler won't be recognized until the registry finishes its first load.</p>
          <p><span className="text-gray-300 font-medium">Unknown samplers</span> above lists IPs actively sending flows that aren't yet registered — click Register to pre-fill the add form with that IP, or Dismiss to silence it without adding it (dismissed IPs stay excluded from ingest).</p>
          <p>CSV import/export and the downloadable template are for bulk provisioning — useful when onboarding many collectors at once instead of adding them one by one.</p>
        </HelpButton>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Gateway for what's allowed to persist — a sampler can be sending flows on the wire, but
        nothing is stored unless its IP is listed here and marked Allowed.
      </p>

      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <p className="text-xs text-gray-500">Live stats refresh every 15s</p>
        <div className="flex items-center gap-2">
          <input
            value={deviceFilter}
            onChange={e => setDeviceFilter(e.target.value)}
            placeholder="Filter devices…"
            className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 w-40 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          {deviceFilter && <button onClick={() => setDeviceFilter('')} className="text-xs text-white hover:text-white">✕</button>}
          <button onClick={handleCsvExport} disabled={csvExporting} className="text-xs text-white hover:text-white border border-gray-700 hover:border-gray-500 rounded-lg px-3 py-2 transition-colors disabled:opacity-50">
            {csvExporting ? 'Exporting…' : '↓ Export CSV'}
          </button>
          <button onClick={downloadTemplate} className="text-xs text-white hover:text-white border border-gray-700 hover:border-gray-500 rounded-lg px-3 py-2 transition-colors">
            Download template
          </button>
          <label className={`text-xs rounded-lg px-3 py-2 transition-colors cursor-pointer border ${csvImporting ? 'opacity-50 cursor-not-allowed border-gray-700 text-gray-500' : 'border-gray-700 text-white hover:border-gray-500 hover:text-white'}`}>
            {csvImporting ? 'Importing…' : 'Import CSV'}
            <input type="file" accept=".csv" className="hidden" onChange={handleCsvImport} disabled={csvImporting} />
          </label>
          <button onClick={() => { setAdding(true); setEditing(null) }} className="bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg px-4 py-2">
            + Add device
          </button>
        </div>
      </div>
      {csvResult && (
        <div className="mb-3 text-xs rounded-lg border border-gray-700 bg-gray-800/50 px-4 py-3 space-y-1">
          <p className="text-white font-medium">Import complete</p>
          <p className="text-white">
            <span className="text-green-400">{csvResult.created} created</span>
            {' · '}
            <span className="text-blue-400">{csvResult.updated} updated</span>
            {csvResult.skipped > 0 && <><span className="text-white"> · </span><span className="text-amber-400">{csvResult.skipped} skipped</span></>}
          </p>
          {csvResult.errors.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {csvResult.errors.map((e, i) => (
                <p key={i} className="text-red-400">Row {e.row}: {e.reason}</p>
              ))}
            </div>
          )}
        </div>
      )}
      {csvError && (
        <p className="mb-3 text-xs text-red-400 px-1">{csvError}</p>
      )}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="px-4 py-3 w-6"></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-white">Device</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-white">Site</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-white">Status</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-white">Flows/s</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-white">Bytes/hr</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-white">Ingest</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {adding && <DeviceForm key="add" d={prefillIp ? { ...EMPTY, ip: prefillIp } : EMPTY} saving={saving} error={error} onSave={save} onCancel={cancelEdit} />}
            {(deviceFilter.trim()
              ? devices.filter(d => {
                  const q = deviceFilter.toLowerCase()
                  return d.ip.includes(q) || d.name.toLowerCase().includes(q) || d.site.toLowerCase().includes(q)
                })
              : devices
            ).map(d => {
              const s = summaryMap[d.ip]
              const status = samplerStatus(s?.last_seen)
              return editing?.id === d.id ? (
                <DeviceForm key={`edit-${d.id}`} d={d} saving={saving} error={error} onSave={save} onCancel={cancelEdit} />
              ) : (
                <tr key={d.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-4 py-3">
                    <span className={`w-2 h-2 rounded-full inline-block ${STATUS_DOT[status]}`} />
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-white font-medium">{d.name || d.ip}</p>
                    <p className="text-xs font-mono text-blue-300">{d.ip}</p>
                  </td>
                  <td className="px-4 py-3 text-white text-sm">{d.site || '—'}</td>
                  <td className={`px-4 py-3 capitalize text-xs font-medium ${STATUS_TEXT[status]}`}>{status}</td>
                  <td className="px-4 py-3 text-right font-mono text-white text-xs">{s ? s.flows_per_sec.toFixed(1) : '—'}</td>
                  <td className="px-4 py-3 text-right font-mono text-white text-xs">{s ? fmtDevBytes(s.bytes_last_hour) : '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded ${d.allowed ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                      {d.allowed ? 'Allowed' : 'Blocked'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-3">
                      <button onClick={() => { setEditing(d); setAdding(false) }} className="text-xs text-white hover:text-blue-400 transition-colors">Edit</button>
                      <button onClick={() => del(d.id)} className="text-xs text-white hover:text-red-400 transition-colors">Remove</button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {devices.length === 0 && !adding && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-white">No devices yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── API Keys tab — per-user external API keys, scoped to whoever is logged in ──
// Providers whose response the user can filter down to specific sections in
// the IP Lookup modal. Keyed by provider id; each entry's field keys match
// what the backend's IPINFO_FIELDS / IPAPI_IS_FIELDS constants accept.
const FIELD_SETS: Record<string, { key: string; label: string }[]> = {
  ipinfo: [
    { key: 'geolocation', label: 'Geolocation' },
    { key: 'asn',         label: 'ASN / Org' },
    { key: 'company',     label: 'Company' },
    { key: 'privacy',     label: 'Privacy Detection (VPN/Proxy/Tor)' },
    { key: 'abuse',       label: 'Abuse Contact' },
    { key: 'domains',     label: 'Hosted Domains' },
  ],
  ipapi_is: [
    { key: 'geolocation', label: 'Geolocation' },
    { key: 'asn',         label: 'ASN / Org' },
    { key: 'company',     label: 'Company' },
    { key: 'detection',   label: 'Threat Detection (VPN/Proxy/Tor/Datacenter)' },
    { key: 'abuse',       label: 'Abuse Contact' },
  ],
  mxtoolbox: [
    { key: 'ptr',       label: 'Reverse DNS (PTR)' },
    { key: 'asn',       label: 'ASN' },
    { key: 'blacklist', label: 'Blacklist Check' },
  ],
}
const setFieldsApi: Record<string, (fields: string[]) => Promise<UserApiKey>> = {
  ipinfo: api.setIpinfoFields,
  ipapi_is: api.setIpapiIsFields,
  mxtoolbox: api.setMxtoolboxFields,
}
// The 4 providers with a section in the IP Lookup modal — AbuseIPDB has no
// per-field checkboxes (single score, not multiple sections) but still gets
// the modal-section on/off toggle. IPQualityScore isn't wired into the modal
// at all, so it gets neither.
const MODAL_PROVIDERS = ['ipinfo', 'ipapi_is', 'abuseipdb', 'mxtoolbox', 'ipqualityscore']

function ApiKeysTab({ lucidToken, onLucidChange, lucidSave }: {
  lucidToken: string
  onLucidChange: (v: string) => void
  lucidSave: { saving: boolean; saved: boolean; error: string; save: () => Promise<void> }
}) {
  const { user } = useAuth()
  const [keys, setKeys]       = useState<UserApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [drafts, setDrafts]   = useState<Record<string, string>>({})
  const [saving, setSaving]   = useState<Record<string, boolean>>({})
  const [saved, setSaved]     = useState<Record<string, boolean>>({})
  const [error, setError]     = useState<Record<string, string>>({})
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; detail: string }>>({})
  const [fieldsError, setFieldsError] = useState('')

  async function handleToggleField(provider: string, fieldKey: string, checked: boolean) {
    const providerKey = keys.find(k => k.provider === provider)
    const current = providerKey?.enabled_fields ?? FIELD_SETS[provider].map(f => f.key)
    const next = checked ? [...current, fieldKey] : current.filter(f => f !== fieldKey)
    setFieldsError('')
    try {
      const updated = await setFieldsApi[provider](next)
      setKeys(prev => prev.map(k => k.provider === provider ? updated : k))
    } catch (err: any) {
      setFieldsError(err.message ?? 'Failed to save')
    }
  }

  async function handleToggleFreeTier(checked: boolean) {
    setFieldsError('')
    try {
      const updated = await api.setIpapiIsFreeTier(checked)
      setKeys(prev => prev.map(k => k.provider === 'ipapi_is' ? updated : k))
    } catch (err: any) {
      setFieldsError(err.message ?? 'Failed to save')
    }
  }

  async function handleToggleEnabled(provider: string, checked: boolean) {
    setFieldsError('')
    try {
      const updated = await api.setProviderEnabled(provider, checked)
      setKeys(prev => prev.map(k => k.provider === provider ? updated : k))
    } catch (err: any) {
      setFieldsError(err.message ?? 'Failed to save')
    }
  }

  function load() {
    setLoading(true)
    api.getUserApiKeys()
      .then(rows => { setKeys(rows); setDrafts(Object.fromEntries(rows.map(r => [r.provider, r.api_key]))) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  async function handleSave(provider: string) {
    setSaving(s => ({ ...s, [provider]: true }))
    setError(e => ({ ...e, [provider]: '' }))
    try {
      const updated = await api.setUserApiKey(provider, drafts[provider] ?? '')
      setKeys(prev => prev.map(k => k.provider === provider ? updated : k))
      setSaved(s => ({ ...s, [provider]: true }))
      setTimeout(() => setSaved(s => ({ ...s, [provider]: false })), 2000)
    } catch (err: any) {
      setError(e => ({ ...e, [provider]: err.message ?? 'Save failed' }))
    } finally {
      setSaving(s => ({ ...s, [provider]: false }))
    }
  }

  async function handleTest(provider: string) {
    setTesting(t => ({ ...t, [provider]: true }))
    setTestResult(r => ({ ...r, [provider]: undefined as any }))
    try {
      const res = await api.testUserApiKey(provider, drafts[provider] ?? '')
      setTestResult(r => ({ ...r, [provider]: { ok: res.status === 'ok', detail: res.detail } }))
    } catch (err: any) {
      setTestResult(r => ({ ...r, [provider]: { ok: false, detail: err.message ?? 'Test failed' } }))
    } finally {
      setTesting(t => ({ ...t, [provider]: false }))
    }
  }

  const inp = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono'

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-white">User Keys</h2>
        <HelpButton title="User Keys — How It Works">
          <p>External API keys for lookup tools (IP reputation, geolocation, etc.) are <span className="text-gray-300 font-medium">personal, not shared</span> — each user stores their own key here under their own account, and only that user's own requests use it. Nobody else, including admins, can see the key's value.</p>
          <p>Leave a field blank and save to clear a key.</p>
        </HelpButton>
      </div>
      <p className="text-sm text-white">
        Signed in as <span className="text-white font-medium">{user?.username}</span> — these keys apply to your account only.
      </p>

      {loading ? (
        <p className="text-sm text-white">Loading…</p>
      ) : (
        <div className="space-y-4 max-w-lg">
          {keys.map(k => {
            const isFreeTier = k.provider === 'ipapi_is' && k.free_tier
            return (
            <div key={k.provider} className="pb-4 border-b-2 border-gray-600 last:border-0 last:pb-0">
              <label className="block text-xs text-white mb-1">{k.label}</label>
              {MODAL_PROVIDERS.includes(k.provider) && (
                <label className="flex items-center gap-2 text-xs text-white cursor-pointer mb-1.5">
                  <input
                    type="checkbox"
                    checked={k.enabled}
                    onChange={e => handleToggleEnabled(k.provider, e.target.checked)}
                    className="accent-blue-600"
                  />
                  Show this provider in the IP Lookup modal
                </label>
              )}
              {k.provider === 'ipapi_is' && (
                <label className="flex items-center gap-2 text-xs text-white cursor-pointer mb-1.5">
                  <input
                    type="checkbox"
                    checked={k.free_tier}
                    onChange={e => handleToggleFreeTier(e.target.checked)}
                    className="accent-blue-600"
                  />
                  Use free tier (no key required, ~1,000 lookups/day)
                </label>
              )}
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={drafts[k.provider] ?? ''}
                  onChange={e => setDrafts(d => ({ ...d, [k.provider]: e.target.value }))}
                  placeholder="Not set"
                  disabled={isFreeTier}
                  className={`${inp} ${isFreeTier ? 'opacity-40 cursor-not-allowed' : ''}`}
                />
                <button
                  onClick={() => handleTest(k.provider)}
                  disabled={isFreeTier || testing[k.provider] || !(drafts[k.provider] ?? '').trim()}
                  className="shrink-0 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
                >
                  {testing[k.provider] ? 'Testing…' : 'Test'}
                </button>
                <button
                  onClick={() => handleSave(k.provider)}
                  disabled={isFreeTier || saving[k.provider]}
                  className="shrink-0 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                >
                  {saving[k.provider] ? 'Saving…' : 'Save'}
                </button>
              </div>
              {saved[k.provider] && <p className="text-xs text-green-400 mt-1">Saved</p>}
              {error[k.provider] && <p className="text-xs text-red-400 mt-1">{error[k.provider]}</p>}
              {testResult[k.provider] && (
                <p className={`text-xs mt-1 ${testResult[k.provider].ok ? 'text-green-400' : 'text-red-400'}`}>
                  {testResult[k.provider].ok ? '✓ ' : '✗ '}{testResult[k.provider].detail}
                </p>
              )}
              {FIELD_SETS[k.provider] && (
                <div className="mt-3 pl-1">
                  <p className="text-xs text-gray-500 mb-1.5">Shown in the IP Lookup modal:</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                    {FIELD_SETS[k.provider].map(f => (
                      <label key={f.key} className="flex items-center gap-2 text-xs text-white cursor-pointer">
                        <input
                          type="checkbox"
                          checked={k.enabled_fields ? k.enabled_fields.includes(f.key) : true}
                          onChange={e => handleToggleField(k.provider, f.key, e.target.checked)}
                          className="accent-blue-600"
                        />
                        {f.label}
                      </label>
                    ))}
                  </div>
                  {fieldsError && <p className="text-xs text-red-400 mt-1">{fieldsError}</p>}
                </div>
              )}
            </div>
          )})}
        </div>
      )}

      <div className="pt-2 border-t border-gray-800 max-w-lg">
        <p className="text-xs font-semibold text-white uppercase tracking-wider mt-4 mb-1">Lucidchart</p>
        <label className="block text-xs text-white mb-1">API token</label>
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={lucidToken}
            onChange={e => onLucidChange(e.target.value)}
            placeholder="eyJ…"
            className={inp}
          />
          <button
            onClick={lucidSave.save}
            disabled={lucidSave.saving}
            className="shrink-0 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >
            {lucidSave.saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {lucidSave.saved && <p className="text-xs text-green-400 mt-1">Saved</p>}
        {lucidSave.error && <p className="text-xs text-red-400 mt-1">{lucidSave.error}</p>}
        <p className="text-xs text-gray-500 mt-1">Personal Access Token from lucid.co → Account → API Tokens. Required for topology export to Lucidchart.</p>
      </div>
    </div>
  )
}

// ── Users tab — local account management (admin only) ─────────────────────────
const ROLES = ['admin', 'viewer', 'analyst']

function badge(active: boolean) {
  return active
    ? 'bg-green-900/40 text-green-400 border border-green-700/40'
    : 'bg-gray-800 text-white border border-gray-700'
}

function roleBadge(role: string) {
  const map: Record<string, string> = {
    admin:   'bg-blue-900/40 text-blue-300 border border-blue-700/40',
    viewer:  'bg-gray-800 text-white border border-gray-700',
    analyst: 'bg-purple-900/40 text-purple-300 border border-purple-700/40',
  }
  return map[role] ?? 'bg-gray-800 text-white border border-gray-700'
}

interface UserModalProps {
  user?: User | null
  onClose: () => void
  onSaved: () => void
}

function UserModal({ user, onClose, onSaved }: UserModalProps) {
  const editing = !!user
  const [form, setForm] = useState<UserIn>({
    username: user?.username ?? '',
    email:    user?.email ?? '',
    role:     user?.role ?? 'viewer',
    password: '',
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const set = (k: keyof UserIn, v: string) => setForm(f => ({ ...f, [k]: v }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editing && !form.password) { setError('Password required for new users'); return }
    setSaving(true)
    try {
      const payload = { ...form, password: form.password || undefined }
      if (editing) await api.updateUser(user!.id, payload)
      else         await api.createUser(payload)
      onSaved()
    } catch (err: any) {
      setError(err.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white mb-5">{editing ? `Edit — ${user!.username}` : 'New User'}</h2>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs text-white block mb-1">Username</label>
            <input value={form.username} onChange={e => set('username', e.target.value)} required
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="text-xs text-white block mb-1">Email</label>
            <input type="email" value={form.email} onChange={e => set('email', e.target.value)} required
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="text-xs text-white block mb-1">
              Password {editing && <span className="text-white">(leave blank to keep current)</span>}
            </label>
            <input type="password" value={form.password} onChange={e => set('password', e.target.value)}
              placeholder={editing ? '••••••••' : 'Required'}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="text-xs text-white block mb-1">Role</label>
            <select value={form.role} onChange={e => set('role', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm text-white hover:text-white transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50">
              {saving ? 'Saving…' : (editing ? 'Save Changes' : 'Create User')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

interface ResetPwProps { user: User; onClose: () => void }

function ResetPasswordModal({ user, onClose }: ResetPwProps) {
  const [pw, setPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pw.length < 6) { setErr('Password must be at least 6 characters'); return }
    if (pw !== confirmPw) { setErr('Passwords do not match'); return }
    setSaving(true)
    try {
      await api.resetUserPassword(user.id, pw)
      onClose()
    } catch (e: any) {
      setErr(e.message ?? 'Failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white mb-1">Reset Password</h2>
        <p className="text-sm text-white mb-5">Set a new password for <span className="text-white font-medium">{user.username}</span></p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs text-white block mb-1">New Password</label>
            <input type="password" value={pw} onChange={e => setPw(e.target.value)} required autoFocus
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="text-xs text-white block mb-1">Confirm Password</label>
            <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} required
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          {err && <p className="text-red-400 text-xs">{err}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-white hover:text-white transition-colors">Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50">
              {saving ? 'Saving…' : 'Set Password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Shared Geo Map helpers ────────────────────────────────────────────────────
function LineSvg({ color, dash }: { color: string; dash: string }) {
  return (
    <svg width="36" height="10" className="flex-shrink-0">
      <line x1="2" y1="5" x2="34" y2="5" stroke={color} strokeWidth="2"
        strokeDasharray={dash || undefined} />
    </svg>
  )
}

// ── Sites Section ───────────────────────────────────────────────────────────
function SitesSection({ isAdmin }: { isAdmin: boolean }) {
  const [sites,    setSites]    = useState<Site[]>([])
  const [loading,  setLoading]  = useState(true)
  const [showAdd,  setShowAdd]  = useState(false)
  const [editId,   setEditId]   = useState<number | null>(null)
  const blank: SiteIn = { name: '', display_name: '', fill_color: '#60a5fa', stroke_color: '#93c5fd', badge_bg: '#374151', badge_text: '#d1d5db', show_in_legend: true, ip_cidr: '' }
  const [form,     setForm]     = useState<SiteIn>(blank)
  const [editForm, setEditForm] = useState<SiteIn>(blank)
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')
  const [page,     setPage]     = useState(1)

  useEffect(() => {
    api.getSites().then(setSites).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const totalPages = Math.max(1, Math.ceil(sites.length / GEO_TABLE_PAGE_SIZE))
  const pageNum     = Math.min(page, totalPages)
  const pageSites    = sites.slice((pageNum - 1) * GEO_TABLE_PAGE_SIZE, pageNum * GEO_TABLE_PAGE_SIZE)

  async function handleAdd() {
    if (!form.name.trim() || !form.display_name.trim()) { setError('Key and Display Name are required'); return }
    setSaving(true); setError('')
    try {
      const s = await api.createSite(form)
      setSites(prev => [...prev, s])
      setForm(blank); setShowAdd(false)
    } catch (e: any) { setError(e.message ?? 'Failed') } finally { setSaving(false) }
  }
  async function handleUpdate() {
    if (!editForm.name.trim() || !editForm.display_name.trim()) { setError('Key and Display Name are required'); return }
    setSaving(true); setError('')
    try {
      const updated = await api.updateSite(editId!, editForm)
      setSites(prev => prev.map(s => s.id === editId ? updated : s))
      setEditId(null)
    } catch (e: any) { setError(e.message ?? 'Failed') } finally { setSaving(false) }
  }
  async function handleDelete(id: number) {
    try {
      await api.deleteSite(id)
      setSites(prev => prev.filter(s => s.id !== id))
    } catch {}
  }
  function handleClone(s: Site) {
    setEditId(null); setError('')
    setForm({ name: '', display_name: s.display_name, fill_color: s.fill_color, stroke_color: s.stroke_color, badge_bg: s.badge_bg, badge_text: s.badge_text, show_in_legend: s.show_in_legend, ip_cidr: s.ip_cidr })
    setShowAdd(true)
  }

  const inp = 'bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-white">Sites</p>
            <HelpButton title="Sites — How It Works">
              <p>A Site's <span className="text-gray-300 font-medium">Key</span> is what a NAT Mapping's <code className="text-gray-400">site_key</code> field references — renaming the key here without updating existing mappings will leave them pointing at a site that no longer matches.</p>
              <p>Every install has one <span className="text-gray-300 font-medium">Default</span> site (key <code className="text-gray-400">default</code>) that new NAT Mappings fall back to. Its key is locked, but the display name, colors, and IP/CIDR stay fully editable, and it can't be deleted.</p>
              <p><span className="text-gray-300 font-medium">IP/CIDR</span> (comma-separated) places this site's color on the <span className="text-gray-300 font-medium">remote</span> end of a flow on the Geo Map — if a flow's public IP falls inside it, that IP gets this site's marker color even without a NAT Mapping. This is separate from NAT Mappings, which color the <span className="text-gray-300 font-medium">local</span> end.</p>
              <p>Each site carries <span className="text-gray-300 font-medium">two independent color pairs</span>: fill/stroke controls the Geo Map circle marker for that site, while badge background/text controls how the site's name is displayed as a pill elsewhere in Settings — they don't have to match.</p>
              <p><span className="text-gray-300 font-medium">Show in legend</span> only affects the Geo Map's Sites legend section — a site with it off still renders on the map, it just isn't listed as a key.</p>
            </HelpButton>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">Define sites, their colours, and IP/CIDR matching for Geo Map circle markers and Settings badges.</p>
        </div>
        {isAdmin && !showAdd && !editId && (
          <button onClick={() => setShowAdd(true)}
            className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
            + Add Site
          </button>
        )}
      </div>

      {showAdd && isAdmin && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3">
          <p className="text-sm font-medium text-white">New Site</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Key (stored)</label>
              <input placeholder="e.g. corporate" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Display Name</label>
              <input placeholder="e.g. Corporate" value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Fill Color</label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.fill_color} onChange={e => setForm(f => ({ ...f, fill_color: e.target.value }))}
                  className="w-10 h-10 rounded cursor-pointer bg-transparent border-0 p-0" />
                <span className="text-xs text-gray-400 font-mono">{form.fill_color}</span>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Stroke Color</label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.stroke_color} onChange={e => setForm(f => ({ ...f, stroke_color: e.target.value }))}
                  className="w-10 h-10 rounded cursor-pointer bg-transparent border-0 p-0" />
                <span className="text-xs text-gray-400 font-mono">{form.stroke_color}</span>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Badge Background Color</label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.badge_bg} onChange={e => setForm(f => ({ ...f, badge_bg: e.target.value }))}
                  className="w-10 h-10 rounded cursor-pointer bg-transparent border-0 p-0" />
                <span className="text-xs text-gray-400 font-mono">{form.badge_bg}</span>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Badge Text Color</label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.badge_text} onChange={e => setForm(f => ({ ...f, badge_text: e.target.value }))}
                  className="w-10 h-10 rounded cursor-pointer bg-transparent border-0 p-0" />
                <span className="text-xs text-gray-400 font-mono">{form.badge_text}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 pt-5">
              <input type="checkbox" id="sg_legend" checked={form.show_in_legend} onChange={e => setForm(f => ({ ...f, show_in_legend: e.target.checked }))}
                className="w-4 h-4 rounded border-gray-600" />
              <label htmlFor="sg_legend" className="text-sm text-gray-300">Show in Geo Map legend</label>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">IP/CIDR (comma-separated, optional)</label>
            <input placeholder="e.g. 1.2.3.4,5.6.0.0/16" value={form.ip_cidr} onChange={e => setForm(f => ({ ...f, ip_cidr: e.target.value }))}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-3">
            <button onClick={handleAdd} disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50">
              {saving ? 'Saving…' : 'Add Site'}
            </button>
            <button onClick={() => { setShowAdd(false); setError('') }}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          </div>
        </div>
      )}

      {loading ? <p className="text-xs text-gray-500 py-4 text-center">Loading…</p> : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-400 uppercase tracking-wider">Key</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-400 uppercase tracking-wider">Display Name</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-400 uppercase tracking-wider">IP/CIDR</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-400 uppercase tracking-wider">Map Color</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-400 uppercase tracking-wider">Badge</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-400 uppercase tracking-wider">In Legend</th>
                {isAdmin && <th className="pl-2 pr-6 py-2.5 w-28" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {pageSites.map(s => editId === s.id ? (
                <tr key={s.id} className="bg-gray-800/60">
                  <td className="px-2 py-2">
                    <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                      disabled={s.name === 'default'} title={s.name === 'default' ? "The Default site's key can't be changed" : undefined}
                      className={`${inp} w-24 disabled:opacity-50 disabled:cursor-not-allowed`} />
                  </td>
                  <td className="px-2 py-2"><input value={editForm.display_name} onChange={e => setEditForm(f => ({ ...f, display_name: e.target.value }))} className={`${inp} w-28`} /></td>
                  <td className="px-2 py-2"><input value={editForm.ip_cidr} onChange={e => setEditForm(f => ({ ...f, ip_cidr: e.target.value }))} placeholder="e.g. 1.2.3.4,5.6.0.0/16" className={`${inp} w-40 font-mono text-xs`} /></td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-2">
                      <input type="color" value={editForm.fill_color} onChange={e => setEditForm(f => ({ ...f, fill_color: e.target.value }))}
                        className="w-8 h-8 rounded cursor-pointer bg-transparent border-0 p-0" title="Fill" />
                      <input type="color" value={editForm.stroke_color} onChange={e => setEditForm(f => ({ ...f, stroke_color: e.target.value }))}
                        className="w-8 h-8 rounded cursor-pointer bg-transparent border-0 p-0" title="Stroke" />
                      <div className="w-6 h-6 rounded-full border-2 flex-shrink-0"
                        style={{ background: editForm.fill_color, borderColor: editForm.stroke_color }} />
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-1.5">
                      <input type="color" value={editForm.badge_bg} onChange={e => setEditForm(f => ({ ...f, badge_bg: e.target.value }))}
                        className="w-8 h-8 rounded cursor-pointer bg-transparent border-0 p-0" title="Badge background color" />
                      <input type="color" value={editForm.badge_text} onChange={e => setEditForm(f => ({ ...f, badge_text: e.target.value }))}
                        className="w-8 h-8 rounded cursor-pointer bg-transparent border-0 p-0" title="Badge text color" />
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <input type="checkbox" checked={editForm.show_in_legend} onChange={e => setEditForm(f => ({ ...f, show_in_legend: e.target.checked }))}
                      className="w-4 h-4 rounded border-gray-600" />
                  </td>
                  <td className="pl-2 pr-6 py-2">
                    {error && <p className="text-xs text-red-400 mb-1">{error}</p>}
                    <div className="flex gap-2 justify-end">
                      <button onClick={handleUpdate} disabled={saving}
                        className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50">
                        {saving ? '…' : 'Save'}
                      </button>
                      <button onClick={() => { setEditId(null); setError('') }}
                        className="px-2 py-1 text-xs text-gray-400 hover:text-white">Cancel</button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={s.id} className="group hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-300">
                    {s.name}
                    {s.name === 'default' && (
                      <span title="Default site — key is locked" className="inline-block ml-1.5 -mt-0.5">
                        <svg className="w-3 h-3 inline text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                        </svg>
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-white">{s.display_name}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-400">{s.ip_cidr || '—'}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-5 rounded-full border-2 flex-shrink-0"
                        style={{ background: s.fill_color, borderColor: s.stroke_color }} />
                      <span className="text-xs text-gray-400 font-mono">{s.fill_color}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="px-2 py-0.5 rounded text-xs font-medium" style={{ backgroundColor: s.badge_bg, color: s.badge_text }}>
                      {s.display_name}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {s.show_in_legend
                      ? <span className="text-green-400 text-sm" title="Shown in Geo Map legend">✓</span>
                      : <span className="text-gray-600 text-sm" title="Hidden from Geo Map legend">—</span>}
                  </td>
                  {isAdmin && (
                    <td className="pl-2 pr-6 py-2.5">
                      <div className="flex items-center gap-2 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => { setEditId(s.id); setEditForm({ name: s.name, display_name: s.display_name, fill_color: s.fill_color, stroke_color: s.stroke_color, badge_bg: s.badge_bg, badge_text: s.badge_text, show_in_legend: s.show_in_legend, ip_cidr: s.ip_cidr }); setError('') }}
                          title="Edit site" className="text-gray-500 hover:text-blue-400 transition-colors">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
                        </button>
                        <button onClick={() => handleClone(s)} title="Clone site" className="text-gray-500 hover:text-emerald-400 transition-colors">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                        </button>
                        {s.name === 'default' ? (
                          <span title="The Default site can't be deleted" className="text-gray-700 cursor-not-allowed">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                          </span>
                        ) : (
                          <button onClick={() => handleDelete(s.id)} title="Delete site" className="text-gray-500 hover:text-red-400 transition-colors">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {totalPages > 1 && (
        <div className="flex justify-end">
          <Pagination page={pageNum} totalPages={totalPages} onChange={setPage} />
        </div>
      )}
    </div>
  )
}

// ── Line Styles Section ───────────────────────────────────────────────────────
function LineStylesSection({ isAdmin }: { isAdmin: boolean }) {
  const [styles,   setStyles]   = useState<LineStyle[]>([])
  const [loading,  setLoading]  = useState(true)
  const [showAdd,  setShowAdd]  = useState(false)
  const [editId,   setEditId]   = useState<number | null>(null)
  const blank: LineStyleIn = { name: '', label: '', color_hex: '#6b7280', dash_pattern: '' }
  const [form,     setForm]     = useState<LineStyleIn>(blank)
  const [editForm, setEditForm] = useState<LineStyleIn>(blank)
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')
  const [page,     setPage]     = useState(1)

  useEffect(() => {
    api.getLineStyles().then(setStyles).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const totalPages = Math.max(1, Math.ceil(styles.length / GEO_TABLE_PAGE_SIZE))
  const pageNum      = Math.min(page, totalPages)
  const pageStyles    = styles.slice((pageNum - 1) * GEO_TABLE_PAGE_SIZE, pageNum * GEO_TABLE_PAGE_SIZE)

  async function handleAdd() {
    if (!form.name.trim() || !form.label.trim()) { setError('Name and Label are required'); return }
    setSaving(true); setError('')
    try {
      const s = await api.createLineStyle(form)
      setStyles(prev => [...prev, s])
      setForm(blank); setShowAdd(false)
    } catch (e: any) { setError(e.message ?? 'Failed') } finally { setSaving(false) }
  }
  async function handleUpdate() {
    setSaving(true); setError('')
    try {
      const updated = await api.updateLineStyle(editId!, editForm)
      setStyles(prev => prev.map(s => s.id === editId ? updated : s))
      setEditId(null)
    } catch (e: any) { setError(e.message ?? 'Failed') } finally { setSaving(false) }
  }
  async function handleDelete(id: number) {
    try {
      await api.deleteLineStyle(id)
      setStyles(prev => prev.filter(s => s.id !== id))
    } catch {}
  }

  const inp = 'bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-white">Line Style Catalog</p>
            <HelpButton title="Line Style Catalog — How It Works">
              <p>This is a shared catalog, not per-rule styling — a style defined here (color + dash pattern) can be assigned to any number of Traffic Rules below. Editing a style's color or dash pattern updates every arc on the Geo Map drawn by a rule using it, all at once.</p>
              <p>Deleting a style that's still assigned to a Traffic Rule doesn't break the rule — matching arcs just fall back to the same neutral gray line used for traffic that matches no rule at all.</p>
            </HelpButton>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">Define arc line styles (color + dash pattern) that can be assigned to traffic types.</p>
        </div>
        {isAdmin && !showAdd && !editId && (
          <button onClick={() => setShowAdd(true)}
            className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
            + Add Style
          </button>
        )}
      </div>

      {showAdd && isAdmin && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3">
          <p className="text-sm font-medium text-white">New Line Style</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Key (stored)</label>
              <input placeholder="e.g. ipsec_line" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Label</label>
              <input placeholder="e.g. Dotted (Purple)" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Color</label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.color_hex} onChange={e => setForm(f => ({ ...f, color_hex: e.target.value }))}
                  className="w-10 h-10 rounded cursor-pointer bg-transparent border-0 p-0" />
                <LineSvg color={form.color_hex} dash={form.dash_pattern} />
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Dash Pattern (SVG)</label>
              <input placeholder="10,5 (blank = solid)" value={form.dash_pattern} onChange={e => setForm(f => ({ ...f, dash_pattern: e.target.value }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-3">
            <button onClick={handleAdd} disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50">
              {saving ? 'Saving…' : 'Add Style'}
            </button>
            <button onClick={() => { setShowAdd(false); setError('') }}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          </div>
        </div>
      )}

      {loading ? <p className="text-xs text-gray-500 py-4 text-center">Loading…</p> : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-400 uppercase tracking-wider">Key</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-400 uppercase tracking-wider">Label</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-400 uppercase tracking-wider">Preview</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-400 uppercase tracking-wider">Dash Pattern</th>
                {isAdmin && <th className="pl-2 pr-6 py-2.5 w-20" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {pageStyles.map(s => editId === s.id ? (
                <tr key={s.id} className="bg-gray-800/60">
                  <td className="px-2 py-2"><input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} className={`${inp} w-24 font-mono text-xs`} /></td>
                  <td className="px-2 py-2"><input value={editForm.label} onChange={e => setEditForm(f => ({ ...f, label: e.target.value }))} className={`${inp} w-32`} /></td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-2">
                      <input type="color" value={editForm.color_hex} onChange={e => setEditForm(f => ({ ...f, color_hex: e.target.value }))}
                        className="w-8 h-8 rounded cursor-pointer bg-transparent border-0 p-0" />
                      <LineSvg color={editForm.color_hex} dash={editForm.dash_pattern} />
                    </div>
                  </td>
                  <td className="px-2 py-2"><input value={editForm.dash_pattern} onChange={e => setEditForm(f => ({ ...f, dash_pattern: e.target.value }))} placeholder="e.g. 10,5 (blank=solid)" className={`${inp} w-40 font-mono text-xs`} /></td>
                  <td className="pl-2 pr-6 py-2">
                    {error && <p className="text-xs text-red-400 mb-1">{error}</p>}
                    <div className="flex gap-2 justify-end">
                      <button onClick={handleUpdate} disabled={saving}
                        className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50">
                        {saving ? '…' : 'Save'}
                      </button>
                      <button onClick={() => { setEditId(null); setError('') }}
                        className="px-2 py-1 text-xs text-gray-400 hover:text-white">Cancel</button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={s.id} className="group hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-300">{s.name}</td>
                  <td className="px-4 py-2.5 text-white">{s.label}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: s.color_hex }} />
                      <LineSvg color={s.color_hex} dash={s.dash_pattern} />
                      <span className="text-xs text-gray-400 font-mono">{s.color_hex}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-400">{s.dash_pattern || 'solid'}</td>
                  {isAdmin && (
                    <td className="pl-2 pr-6 py-2.5">
                      <div className="flex items-center gap-2 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => { setEditId(s.id); setEditForm({ name: s.name, label: s.label, color_hex: s.color_hex, dash_pattern: s.dash_pattern }); setError('') }}
                          className="text-gray-500 hover:text-blue-400 transition-colors">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
                        </button>
                        <button onClick={() => handleDelete(s.id)} className="text-gray-500 hover:text-red-400 transition-colors">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {totalPages > 1 && (
        <div className="flex justify-end">
          <Pagination page={pageNum} totalPages={totalPages} onChange={setPage} />
        </div>
      )}
    </div>
  )
}

// ── Geo Map Tab (wrapper) ─────────────────────────────────────────────────────
function GeoMapTab() {
  const { user: _me } = useAuth()
  const isAdmin = _me?.role === 'admin'
  return (
    <div className="space-y-10">
      <SitesSection isAdmin={isAdmin} />
      <div className="border-t border-gray-800" />
      <NatMappingsSection isAdmin={isAdmin} />
      <div className="border-t border-gray-800" />
      <TrafficRulesSection isAdmin={isAdmin} />
      <div className="border-t border-gray-800" />
      <LineStylesSection isAdmin={isAdmin} />
    </div>
  )
}

// ── NAT Mappings Section ──────────────────────────────────────────────────────
// Merges what used to be two separate boxes (VPN Site Mappings + WAN
// Addresses) — both mapped a private CIDR/IP to a representative external
// CIDR/IP for geolocation, differing only in label. `category` keeps that as
// a cosmetic badge. Order (drag-and-drop) sets `priority`: when both ends of
// a flow match a different entry, whichever is higher in this list wins.
const NAT_SITE_BADGE: Record<string, string> = {
  group_a: 'bg-violet-800 text-violet-200',
  group_b: 'bg-emerald-800 text-emerald-200',
  default: 'bg-gray-700 text-gray-300',
}
const CATEGORY_BADGE: Record<string, string> = {
  wan: 'bg-red-900 text-red-200',
  vpn: 'bg-blue-900 text-blue-200',
}

const DragHandle = () => (
  <svg className="w-4 h-4 text-gray-600 cursor-grab active:cursor-grabbing flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
    <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
    <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
  </svg>
)

function LineStylePreview({ lineStyles, id }: { lineStyles: LineStyle[]; id: number | null }) {
  if (!id) return <span className="text-xs text-gray-500">—</span>
  const ls = lineStyles.find(l => l.id === id)
  if (!ls) return <span className="text-xs text-gray-500">—</span>
  return (
    <div className="flex items-center gap-2">
      <svg width="26" height="7"><line x1="0" y1="3.5" x2="26" y2="3.5" stroke={ls.color_hex} strokeWidth="2" strokeDasharray={ls.dash_pattern || undefined} /></svg>
      <span className="text-xs text-gray-400">{ls.label}</span>
    </div>
  )
}

function NatMappingsSection({ isAdmin }: { isAdmin: boolean }) {
  const [mappings,   setMappings]   = useState<NatMapping[]>([])
  const [loading,    setLoading]    = useState(true)
  const [showAdd,    setShowAdd]    = useState(false)
  const [editingId,  setEditingId]  = useState<number | null>(null)
  const blank: NatMappingIn = { name: '', site_key: 'default', category: 'wan', private_cidr: '', public_cidr: '', dst_cidrs: null, dst_ports: null, show_in_legend: true }
  const [editForm,   setEditForm]   = useState<NatMappingIn>(blank)
  const [form,       setForm]       = useState<NatMappingIn>(blank)
  const [saving,       setSaving]       = useState(false)
  const [editSaving,   setEditSaving]   = useState(false)
  const [error,        setError]        = useState('')
  const [editError,    setEditError]    = useState('')
  const [sites,       setSites]       = useState<Site[]>([])
  const [ispDhcp,          setIspDhcp]          = useState(false)
  const [ispDhcpMappingId, setIspDhcpMappingId] = useState<number | null>(null)
  const [ispDhcpSaving,    setIspDhcpSaving]    = useState(false)
  const [page,             setPage]             = useState(1)
  const dragId = useRef<number | null>(null)
  const siteOptions = sites.length
    ? sites.map(s => ({ value: s.name, label: s.display_name }))
    : [{ value: 'default', label: 'Default' }, { value: 'group_a', label: 'Group A' }, { value: 'group_b', label: 'Group B' }]

  const totalPages  = Math.max(1, Math.ceil(mappings.length / GEO_TABLE_PAGE_SIZE))
  const pageNum       = Math.min(page, totalPages)
  const pageMappings   = mappings.slice((pageNum - 1) * GEO_TABLE_PAGE_SIZE, pageNum * GEO_TABLE_PAGE_SIZE)

  function load() {
    setLoading(true)
    Promise.all([
      api.getNatMappings(),
      api.getSites(),
      api.getSettings(),
    ]).then(([m, s, settings]) => {
      setMappings(m); setSites(s)
      setIspDhcp(Boolean(settings.isp_dhcp_enabled))
      setIspDhcpMappingId((settings.isp_dhcp_mapping_id as number | null) ?? null)
    })
      .catch(() => {})
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  function refreshSites() {
    api.getSites().then(setSites).catch(() => {})
  }

  async function handleToggleIspDhcp(checked: boolean) {
    setIspDhcpSaving(true)
    try {
      await api.updateSetting('isp_dhcp_enabled', checked)
      load()
    } catch {
      setIspDhcpSaving(false)
    }
  }

  async function handleAdd() {
    if (!form.name.trim() || !form.private_cidr.trim() || !form.public_cidr.trim()) {
      setError('Name, Private CIDR/IP, and Public/External CIDR/IP are required'); return
    }
    setSaving(true); setError('')
    try {
      const m = await api.createNatMapping(form)
      setMappings(prev => [...prev, m])
      setForm(blank)
      setShowAdd(false)
    } catch (e: any) {
      setError(e.message ?? 'Failed to save')
    } finally { setSaving(false) }
  }

  function startEdit(m: NatMapping) {
    setEditingId(m.id)
    setEditForm({ name: m.name, site_key: m.site_key, category: m.category, private_cidr: m.private_cidr, public_cidr: m.public_cidr, dst_cidrs: m.dst_cidrs, dst_ports: m.dst_ports, show_in_legend: m.show_in_legend })
    setEditError('')
  }
  function cancelEdit() { setEditingId(null); setEditError('') }

  function handleClone(m: NatMapping) {
    setEditingId(null); setError('')
    setForm({ name: '', site_key: m.site_key, category: m.category, private_cidr: m.private_cidr, public_cidr: m.public_cidr, dst_cidrs: m.dst_cidrs, dst_ports: m.dst_ports, show_in_legend: m.show_in_legend })
    setShowAdd(true)
  }

  async function handleUpdate() {
    if (!editForm.name.trim() || !editForm.private_cidr.trim() || !editForm.public_cidr.trim()) {
      setEditError('Name, Private CIDR/IP, and Public/External CIDR/IP are required'); return
    }
    setEditSaving(true); setEditError('')
    try {
      const updated = await api.updateNatMapping(editingId!, editForm)
      setMappings(prev => prev.map(m => m.id === editingId ? updated : m))
      setEditingId(null)
    } catch (e: any) {
      setEditError(e.message ?? 'Failed to update')
    } finally { setEditSaving(false) }
  }

  async function handleDelete(id: number) {
    try {
      await api.deleteNatMapping(id)
      setMappings(prev => prev.filter(m => m.id !== id))
    } catch {}
  }

  function handleDragStart(id: number) { dragId.current = id }
  async function handleDrop(targetId: number) {
    const dragged = dragId.current
    dragId.current = null
    if (dragged === null || dragged === targetId) return
    const current = mappings.map(m => m.id)
    const from = current.indexOf(dragged)
    const to   = current.indexOf(targetId)
    if (from === -1 || to === -1) return
    const reordered = [...current]
    reordered.splice(from, 1)
    reordered.splice(to, 0, dragged)
    setMappings(prev => reordered.map(id => prev.find(m => m.id === id)!))
    try {
      const updated = await api.reorderNatMappings(reordered)
      setMappings(updated)
    } catch { load() }
  }

  const inp = 'w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-white">Private/Public NAT Mapping</h2>
          <HelpButton title="Private/Public NAT Mapping — How It Works">
            <p>Tells the Geo Map "this private range is really at this location" — nothing more. This section has <span className="text-gray-300 font-medium">no effect on line colors or styling</span>; that all happens in Traffic Rules below, which references these entries by name.</p>
            <p><span className="text-gray-300 font-medium">Private CIDR/IP is required</span> — it's the only thing that makes an entry match real traffic (a flow's private-side IP falling inside it). <span className="text-gray-300 font-medium">Public/External CIDR or IP</span> is what gets geolocated to place it on the map: a single firewall IP for a site (e.g. <code className="text-gray-400">10.10.0.0/16</code> → <code className="text-gray-400">23.92.28.254/32</code>), or a whole block if a site's traffic egresses from a range (e.g. a VPN exit node's <code className="text-gray-400">/24</code>). If you're trying to classify traffic to some external service instead of mapping one of your own ranges, you want a Traffic Rule, not an entry here — see the "Any" option there.</p>
            <p>Multiple entries may share the same private and/or public CIDR — drag rows to reorder; whichever entry is higher in this list wins when more than one matches the same flow, and is also the one whose Traffic Rules get checked for that arc's style.</p>
            <p><span className="text-gray-300 font-medium">Destination CIDR/IP and Port</span> (optional) scope this mapping to only apply when the flow's remote end matches — this is what lets the SAME private range resolve to a DIFFERENT public CIDR depending on where the traffic is headed. E.g. a firewall that NATs DNS traffic (port 53) out one public IP and everything else out another: two entries, same Private CIDR, one with Destination Port <code className="text-gray-400">53</code> above the other (blank Destination Port) in priority order. Leave both blank to match any destination — the common case.</p>
            <p><span className="text-gray-300 font-medium">Show in legend</span> controls whether this entry appears in the Geo Map's NAT Mappings legend section.</p>
            <p><span className="text-gray-300 font-medium">ISP DHCP</span> is for networks with no static public IP: checking it locks every mapping here (nothing below is editable or used) and creates a single synthetic "Default" mapping that catches all private traffic instead, with no fixed map placement of its own since the public IP isn't fixed. Unchecking it deletes that synthetic mapping and restores everything else — if you built a Traffic Rule scoped to it while DHCP was on, that rule is deleted along with it.</p>
          </HelpButton>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
            <input type="checkbox" checked={ispDhcp} disabled={!isAdmin || ispDhcpSaving}
              onChange={e => handleToggleIspDhcp(e.target.checked)}
              className="w-4 h-4 rounded border-gray-600" />
            ISP DHCP
          </label>
          {isAdmin && !showAdd && (
            <button
              onClick={() => setShowAdd(true)}
              disabled={ispDhcp}
              className="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
            >
              + Add Mapping
            </button>
          )}
        </div>
      </div>

      {/* Add form */}
      {showAdd && isAdmin && !ispDhcp && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-medium text-white">New NAT Mapping</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Name</label>
              <input placeholder="e.g. Site A" value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Site</label>
              <select value={form.site_key} onChange={e => setForm(f => ({ ...f, site_key: e.target.value }))}
                onFocus={refreshSites}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                {siteOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Category</label>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value as 'wan' | 'vpn' }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="wan">WAN</option>
                <option value="vpn">VPN</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Private CIDR or IP</label>
              <input placeholder="e.g. 10.42.0.0/16" value={form.private_cidr}
                onChange={e => setForm(f => ({ ...f, private_cidr: e.target.value }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Public/External CIDR or IP</label>
              <input placeholder="e.g. 23.92.28.254/32" value={form.public_cidr}
                onChange={e => setForm(f => ({ ...f, public_cidr: e.target.value }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Destination CIDR/IP (optional)</label>
              <input placeholder="e.g. 1.1.1.1,9.9.9.9" value={form.dst_cidrs ?? ''}
                onChange={e => setForm(f => ({ ...f, dst_cidrs: e.target.value || null }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Destination Port (optional)</label>
              <input placeholder="e.g. 53,8000-9000" value={form.dst_ports ?? ''}
                onChange={e => setForm(f => ({ ...f, dst_ports: e.target.value || null }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="flex items-center gap-2 pt-5">
              <input type="checkbox" id="nm_legend" checked={form.show_in_legend} onChange={e => setForm(f => ({ ...f, show_in_legend: e.target.checked }))}
                className="w-4 h-4 rounded border-gray-600" />
              <label htmlFor="nm_legend" className="text-sm text-gray-300">Show in Geo Map legend</label>
            </div>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button onClick={handleAdd} disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50">
              {saving ? 'Saving…' : 'Add Mapping'}
            </button>
            <button onClick={() => { setShowAdd(false); setError('') }}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Mappings table */}
      {loading ? (
        <p className="text-sm text-gray-500 text-center py-8">Loading…</p>
      ) : mappings.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p className="text-sm">No NAT mappings configured.</p>
          <p className="text-xs mt-1">Add one to plot that traffic at the correct location on the Geo Map.</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                {isAdmin && <th className="w-8" />}
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">Site</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">Category</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">Private CIDR / IP</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">Public / External</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">Destination</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">Port</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">In Legend</th>
                {isAdmin && <th className="pl-2 pr-6 py-3 w-28 text-right text-xs font-medium text-gray-400 uppercase tracking-wider">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {pageMappings.map(m => {
                const isDhcpRow = ispDhcp && m.id === ispDhcpMappingId
                const isLocked  = ispDhcp && !isDhcpRow
                return editingId === m.id ? (
                /* ── Edit row ── */
                <tr key={m.id} className="bg-gray-800/60">
                  {isAdmin && <td />}
                  <td className="px-2 py-2"><input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} className={inp} /></td>
                  <td className="px-2 py-2">
                    <select value={editForm.site_key} onChange={e => setEditForm(f => ({ ...f, site_key: e.target.value }))} onFocus={refreshSites} className={inp}>
                      {siteOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <select value={editForm.category} onChange={e => setEditForm(f => ({ ...f, category: e.target.value as 'wan' | 'vpn' }))} className={inp}>
                      <option value="wan">WAN</option>
                      <option value="vpn">VPN</option>
                    </select>
                  </td>
                  <td className="px-2 py-2"><input value={editForm.private_cidr} onChange={e => setEditForm(f => ({ ...f, private_cidr: e.target.value }))} className={`${inp} font-mono`} /></td>
                  <td className="px-2 py-2"><input value={editForm.public_cidr} onChange={e => setEditForm(f => ({ ...f, public_cidr: e.target.value }))} className={`${inp} font-mono`} /></td>
                  <td className="px-2 py-2"><input value={editForm.dst_cidrs ?? ''} onChange={e => setEditForm(f => ({ ...f, dst_cidrs: e.target.value || null }))} placeholder="any" className={`${inp} w-32 font-mono text-xs`} /></td>
                  <td className="px-2 py-2"><input value={editForm.dst_ports ?? ''} onChange={e => setEditForm(f => ({ ...f, dst_ports: e.target.value || null }))} placeholder="any" className={`${inp} w-24 font-mono text-xs`} /></td>
                  <td className="px-2 py-2">
                    <input type="checkbox" checked={editForm.show_in_legend} onChange={e => setEditForm(f => ({ ...f, show_in_legend: e.target.checked }))}
                      className="w-4 h-4 rounded border-gray-600" />
                  </td>
                  <td className="pl-2 pr-6 py-2">
                    {editError && <p className="text-xs text-red-400 mb-1">{editError}</p>}
                    <div className="flex items-center gap-2 justify-end">
                      <button onClick={handleUpdate} disabled={editSaving}
                        className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50">
                        {editSaving ? '…' : 'Save'}
                      </button>
                      <button onClick={cancelEdit} className="px-3 py-1 text-xs text-gray-400 hover:text-white transition-colors">
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                /* ── Display row ── */
                <tr key={m.id}
                  draggable={isAdmin && !ispDhcp}
                  onDragStart={() => handleDragStart(m.id)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={() => handleDrop(m.id)}
                  className={`group hover:bg-gray-800/50 transition-colors ${isLocked ? 'opacity-40' : ''}`}>
                  {isAdmin && <td className="pl-3">{!ispDhcp && <DragHandle />}</td>}
                  <td className="px-4 py-3 text-white font-medium">
                    {m.name}
                    {isDhcpRow && <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-900 text-blue-200 align-middle">DHCP</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${NAT_SITE_BADGE[m.site_key] ?? NAT_SITE_BADGE.default}`}>
                      {m.site_key.charAt(0).toUpperCase() + m.site_key.slice(1)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${CATEGORY_BADGE[m.category]}`}>
                      {m.category.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-gray-300">{m.private_cidr}</td>
                  <td className="px-4 py-3 font-mono text-gray-300">{m.public_cidr || '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-400">{m.dst_cidrs || 'any'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-400">{m.dst_ports || 'any'}</td>
                  <td className="px-4 py-3">
                    {m.show_in_legend
                      ? <span className="text-green-400 text-sm" title="Shown in Geo Map legend">✓</span>
                      : <span className="text-gray-600 text-sm" title="Hidden from Geo Map legend">—</span>}
                  </td>
                  {isAdmin && (
                    <td className="pl-2 pr-6 py-3">
                      {!ispDhcp && (
                        <div className="flex items-center gap-2 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={() => startEdit(m)} title="Edit mapping"
                            className="text-gray-500 hover:text-blue-400 transition-colors">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
                            </svg>
                          </button>
                          <button onClick={() => handleClone(m)} title="Clone mapping"
                            className="text-gray-500 hover:text-emerald-400 transition-colors">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                            </svg>
                          </button>
                          <button onClick={() => handleDelete(m.id)} title="Delete mapping"
                            className="text-gray-500 hover:text-red-400 transition-colors">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                            </svg>
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              )})}
            </tbody>
          </table>
        </div>
      )}
      {totalPages > 1 && (
        <div className="flex justify-end">
          <Pagination page={pageNum} totalPages={totalPages} onChange={setPage} />
        </div>
      )}
    </div>
  )
}

// ── Traffic Rules Section ─────────────────────────────────────────────────────
function TrafficRulesSection({ isAdmin }: { isAdmin: boolean }) {
  const [rules,      setRules]      = useState<TrafficRule[]>([])
  const [mappings,   setMappings]   = useState<NatMapping[]>([])
  const [sites,      setSites]      = useState<Site[]>([])
  const [lineStyles, setLineStyles] = useState<LineStyle[]>([])
  const [loading,    setLoading]    = useState(true)
  const [showAdd,    setShowAdd]    = useState(false)
  const [editingId,  setEditingId]  = useState<number | null>(null)
  const blank: TrafficRuleIn = { name: '', nat_mapping_id: null, dst_cidrs: '', dst_site_key: null, dst_ports: '', line_style_id: null }
  const [editForm,   setEditForm]   = useState<TrafficRuleIn>(blank)
  const [form,       setForm]       = useState<TrafficRuleIn>(blank)
  // Destination mode: 'cidr' (manual entry) or 'site' (dropdown). The Add
  // form lets the admin pick either, freely, until something's typed. The
  // Edit form's mode is fixed from the rule's existing data the moment
  // editing starts — see startEdit — matching the backend's PUT guard that
  // rejects switching an existing rule between the two.
  const [addDestMode,  setAddDestMode]  = useState<'cidr' | 'site'>('cidr')
  const [editDestMode, setEditDestMode] = useState<'cidr' | 'site' | 'none'>('none')
  const [saving,       setSaving]       = useState(false)
  const [editSaving,   setEditSaving]   = useState(false)
  const [error,        setError]        = useState('')
  const [editError,    setEditError]    = useState('')
  const [page,         setPage]         = useState(1)
  const dragId = useRef<number | null>(null)
  const siteOptions = sites.map(s => ({ value: s.name, label: s.display_name }))

  const totalPages = Math.max(1, Math.ceil(rules.length / GEO_TABLE_PAGE_SIZE))
  const pageNum     = Math.min(page, totalPages)
  const pageRules    = rules.slice((pageNum - 1) * GEO_TABLE_PAGE_SIZE, pageNum * GEO_TABLE_PAGE_SIZE)

  function load() {
    setLoading(true)
    Promise.all([
      api.getTrafficRules(),
      api.getNatMappings(),
      api.getSites(),
      api.getLineStyles(),
    ]).then(([r, m, s, ls]) => { setRules(r); setMappings(m); setSites(s); setLineStyles(ls) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  function refreshMappings() {
    api.getNatMappings().then(setMappings).catch(() => {})
  }
  function refreshSites() {
    api.getSites().then(setSites).catch(() => {})
  }

  async function handleAdd() {
    if (!form.name.trim() || (form.nat_mapping_id == null && !form.dst_cidrs?.trim() && !form.dst_site_key && !form.dst_ports?.trim())) {
      setError('Name is required, and at least one of NAT Mapping, Destination (IPs/CIDRs or Site), or Destination Ports'); return
    }
    setSaving(true); setError('')
    try {
      const body = { ...form, dst_cidrs: form.dst_cidrs?.trim() || null, dst_ports: form.dst_ports?.trim() || null }
      const r = await api.createTrafficRule(body)
      setRules(prev => [...prev, r])
      setForm(blank)
      setAddDestMode('cidr')
      setShowAdd(false)
    } catch (e: any) {
      setError(e.message ?? 'Failed to save')
    } finally { setSaving(false) }
  }

  function startEdit(r: TrafficRule) {
    setEditingId(r.id)
    setEditForm({ name: r.name, nat_mapping_id: r.nat_mapping_id, dst_cidrs: r.dst_cidrs ?? '', dst_site_key: r.dst_site_key, dst_ports: r.dst_ports ?? '', line_style_id: r.line_style_id })
    setEditDestMode(r.dst_site_key ? 'site' : r.dst_cidrs ? 'cidr' : 'none')
    setEditError('')
  }
  function cancelEdit() { setEditingId(null); setEditError('') }

  function handleClone(r: TrafficRule) {
    setEditingId(null); setError('')
    setForm({ name: '', nat_mapping_id: r.nat_mapping_id, dst_cidrs: r.dst_cidrs, dst_site_key: r.dst_site_key, dst_ports: r.dst_ports, line_style_id: r.line_style_id })
    setAddDestMode(r.dst_site_key ? 'site' : 'cidr')
    setShowAdd(true)
  }

  async function handleUpdate() {
    if (!editForm.name.trim() || (editForm.nat_mapping_id == null && !editForm.dst_cidrs?.trim() && !editForm.dst_site_key && !editForm.dst_ports?.trim())) {
      setEditError('Name is required, and at least one of NAT Mapping, Destination (IPs/CIDRs or Site), or Destination Ports'); return
    }
    setEditSaving(true); setEditError('')
    try {
      const body = { ...editForm, dst_cidrs: editForm.dst_cidrs?.trim() || null, dst_ports: editForm.dst_ports?.trim() || null }
      const updated = await api.updateTrafficRule(editingId!, body)
      setRules(prev => prev.map(r => r.id === editingId ? updated : r))
      setEditingId(null)
    } catch (e: any) {
      setEditError(e.message ?? 'Failed to update')
    } finally { setEditSaving(false) }
  }

  async function handleDelete(id: number) {
    try {
      await api.deleteTrafficRule(id)
      setRules(prev => prev.filter(r => r.id !== id))
    } catch {}
  }

  function handleDragStart(id: number) { dragId.current = id }
  async function handleDrop(targetId: number) {
    const dragged = dragId.current
    dragId.current = null
    if (dragged === null || dragged === targetId) return
    const current = rules.map(r => r.id)
    const from = current.indexOf(dragged)
    const to   = current.indexOf(targetId)
    if (from === -1 || to === -1) return
    const reordered = [...current]
    reordered.splice(from, 1)
    reordered.splice(to, 0, dragged)
    setRules(prev => reordered.map(id => prev.find(r => r.id === id)!))
    try {
      const updated = await api.reorderTrafficRules(reordered)
      setRules(updated)
    } catch { load() }
  }

  const inp = 'w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-white">Traffic Rules</h2>
          <HelpButton title="Traffic Rules — How It Works">
            <p>This is the <span className="text-gray-300 font-medium">only</span> place a line color/style gets chosen for the Geo Map. NAT Mappings above just supplies locations — a rule decides what a matching flow looks like.</p>
            <p><span className="text-gray-300 font-medium">Matching is top-to-bottom, first hit wins.</span> Each rule can filter on any combination of: which NAT Mapping the traffic belongs to ("Any" = every mapping), Destination IPs/CIDRs, and Destination Ports. At least one filter is required. Rules are checked in the order shown below — as soon as one matches, its Line Style is used and nothing else is checked.</p>
            <p><span className="text-gray-300 font-medium">Multiple values:</span> list several IPs/CIDRs or ports/ranges in one rule by separating them with commas — a destination matching <span className="text-gray-300">any</span> listed value counts as a match. Destinations: <code className="text-gray-400">1.1.1.1, 9.9.9.9</code>. Ports: <code className="text-gray-400">53, 8000-9000</code> (ranges use a dash and are inclusive on both ends).</p>
            <p><span className="text-gray-300 font-medium">Destination: manual entry or a Site.</span> Type CIDRs/IPs directly, or pick a Site instead — matching then uses that Site's own IP/CIDR field, live (edit the Site later and every rule pointing at it picks up the change automatically). One or the other, never both. Once a rule is created with one, it's locked to that mode — delete and recreate it to switch.</p>
            <p><span className="text-gray-300 font-medium">Examples:</span> NAT Mapping = "Site A", Destinations = <code className="text-gray-400">1.1.1.1, 9.9.9.9</code>, Ports = blank → "Site A's traffic to Cloudflare or Quad9 DNS, any port." NAT Mapping = "Any", Destinations = blank, Ports = <code className="text-gray-400">53</code> → "any DNS traffic, from anywhere I've mapped, to anywhere." NAT Mapping = "Site A", Destinations = blank, Ports = blank → "everything else from Site A" — a catch-all/default for that one mapping.</p>
            <p><span className="text-amber-500 font-medium">Ordering matters most for catch-alls:</span> a rule with no Destination or Port filter matches everything for that NAT Mapping, so it will shadow any more specific rule listed below it. Always drag your specific rules (like the DNS example) above a catch-all for the same mapping, or the catch-all wins first and the specific one never gets reached.</p>
            <p>Traffic that matches no rule at all falls back to a plain gray line.</p>
          </HelpButton>
        </div>
        {isAdmin && !showAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
          >
            + Add Rule
          </button>
        )}
      </div>

      {/* Add form */}
      {showAdd && isAdmin && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-medium text-white">New Traffic Rule</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Name</label>
              <input placeholder="e.g. DNS - Cloudflare/Quad9" value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">NAT Mapping</label>
              <select value={form.nat_mapping_id ?? ''} onChange={e => setForm(f => ({ ...f, nat_mapping_id: e.target.value ? Number(e.target.value) : null }))}
                onFocus={refreshMappings}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Any</option>
                {mappings.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Line Style</label>
              <select value={form.line_style_id ?? ''} onChange={e => setForm(f => ({ ...f, line_style_id: e.target.value ? Number(e.target.value) : null }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">— none —</option>
                {lineStyles.map(ls => <option key={ls.id} value={ls.id}>{ls.label}</option>)}
              </select>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs text-gray-400">Destination (optional)</label>
                <div className="flex rounded overflow-hidden border border-gray-600 text-[10px]">
                  <button type="button" onClick={() => { setAddDestMode('cidr'); setForm(f => ({ ...f, dst_site_key: null })) }}
                    className={`px-2 py-0.5 ${addDestMode === 'cidr' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400 hover:text-gray-200'}`}>
                    Manual
                  </button>
                  <button type="button" onClick={() => { setAddDestMode('site'); setForm(f => ({ ...f, dst_cidrs: '' })) }}
                    className={`px-2 py-0.5 ${addDestMode === 'site' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400 hover:text-gray-200'}`}>
                    Site
                  </button>
                </div>
              </div>
              {addDestMode === 'cidr' ? (
                <input placeholder="e.g. 1.1.1.1, 9.9.9.9" value={form.dst_cidrs ?? ''}
                  onChange={e => setForm(f => ({ ...f, dst_cidrs: e.target.value }))}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
              ) : (
                <select value={form.dst_site_key ?? ''} onChange={e => setForm(f => ({ ...f, dst_site_key: e.target.value || null }))}
                  onFocus={refreshSites}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">— pick a site —</option>
                  {siteOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              )}
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Destination Ports (optional, comma-separated, ranges OK)</label>
              <input placeholder="e.g. 53, 8000-9000" value={form.dst_ports ?? ''}
                onChange={e => setForm(f => ({ ...f, dst_ports: e.target.value }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <p className="text-xs text-gray-500">At least one filter is required. List multiple values separated by commas (e.g. "1.1.1.1, 9.9.9.9" or "53, 8000-9000"). Leave Destination blank to match any destination on that port; leave Ports blank to match any port; leave both blank (with a NAT Mapping picked) to make this the default/catch-all for that mapping — put it below any more specific rules for the same mapping.</p>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button onClick={handleAdd} disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50">
              {saving ? 'Saving…' : 'Add Rule'}
            </button>
            <button onClick={() => { setShowAdd(false); setError('') }}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Rules table */}
      {loading ? (
        <p className="text-sm text-gray-500 text-center py-8">Loading…</p>
      ) : rules.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p className="text-sm">No traffic rules configured.</p>
          <p className="text-xs mt-1">Add one to give specific destinations/ports their own line on the Geo Map.</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                {isAdmin && <th className="w-8" />}
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">NAT Mapping</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">Destinations</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">Ports</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">Line Style</th>
                {isAdmin && <th className="pl-2 pr-6 py-3 w-20 text-right text-xs font-medium text-gray-400 uppercase tracking-wider">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {pageRules.map(r => editingId === r.id ? (
                /* ── Edit row ── */
                <tr key={r.id} className="bg-gray-800/60">
                  {isAdmin && <td />}
                  <td className="px-2 py-2"><input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} className={inp} /></td>
                  <td className="px-2 py-2">
                    <select value={editForm.nat_mapping_id ?? ''} onChange={e => setEditForm(f => ({ ...f, nat_mapping_id: e.target.value ? Number(e.target.value) : null }))} onFocus={refreshMappings} className={inp}>
                      <option value="">Any</option>
                      {mappings.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    {editDestMode === 'none' && (
                      <div className="flex rounded overflow-hidden border border-gray-600 text-[10px] mb-1 w-fit">
                        <button type="button" onClick={() => setEditDestMode('cidr')} className="px-2 py-0.5 bg-gray-700 text-gray-400 hover:text-gray-200">Manual</button>
                        <button type="button" onClick={() => setEditDestMode('site')} className="px-2 py-0.5 bg-gray-700 text-gray-400 hover:text-gray-200">Site</button>
                      </div>
                    )}
                    {editDestMode === 'site' ? (
                      <select value={editForm.dst_site_key ?? ''} onChange={e => setEditForm(f => ({ ...f, dst_site_key: e.target.value || null }))} onFocus={refreshSites} className={inp}>
                        <option value="">— pick a site —</option>
                        {siteOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : (
                      <input value={editForm.dst_cidrs ?? ''} onChange={e => setEditForm(f => ({ ...f, dst_cidrs: e.target.value }))} className={`${inp} font-mono`} />
                    )}
                  </td>
                  <td className="px-2 py-2"><input value={editForm.dst_ports ?? ''} onChange={e => setEditForm(f => ({ ...f, dst_ports: e.target.value }))} className={`${inp} font-mono`} /></td>
                  <td className="px-2 py-2">
                    <select value={editForm.line_style_id ?? ''} onChange={e => setEditForm(f => ({ ...f, line_style_id: e.target.value ? Number(e.target.value) : null }))} className={inp}>
                      <option value="">— none —</option>
                      {lineStyles.map(ls => <option key={ls.id} value={ls.id}>{ls.label}</option>)}
                    </select>
                  </td>
                  <td className="pl-2 pr-6 py-2">
                    {editError && <p className="text-xs text-red-400 mb-1">{editError}</p>}
                    <div className="flex items-center gap-2 justify-end">
                      <button onClick={handleUpdate} disabled={editSaving}
                        className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50">
                        {editSaving ? '…' : 'Save'}
                      </button>
                      <button onClick={cancelEdit} className="px-3 py-1 text-xs text-gray-400 hover:text-white transition-colors">
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                /* ── Display row ── */
                <tr key={r.id}
                  draggable={isAdmin}
                  onDragStart={() => handleDragStart(r.id)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={() => handleDrop(r.id)}
                  className="group hover:bg-gray-800/50 transition-colors">
                  {isAdmin && <td className="pl-3"><DragHandle /></td>}
                  <td className="px-4 py-3 text-white font-medium">{r.name}</td>
                  <td className="px-4 py-3 text-gray-300">
                    {r.nat_mapping_id ? (mappings.find(m => m.id === r.nat_mapping_id)?.name ?? `#${r.nat_mapping_id}`) : <span className="text-gray-500">Any</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-300">
                    {r.dst_site_key
                      ? <span className="font-sans"><span className="text-gray-500">Site:</span> {sites.find(s => s.name === r.dst_site_key)?.display_name ?? r.dst_site_key}</span>
                      : r.dst_cidrs
                        ? <span className="font-mono">{r.dst_cidrs}</span>
                        : <span className="text-gray-500 font-sans">Any</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-gray-300">{r.dst_ports || <span className="text-gray-500 font-sans">Any</span>}</td>
                  <td className="px-4 py-3"><LineStylePreview lineStyles={lineStyles} id={r.line_style_id} /></td>
                  {isAdmin && (
                    <td className="pl-2 pr-6 py-3">
                      <div className="flex items-center gap-2 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => startEdit(r)} title="Edit rule"
                          className="text-gray-500 hover:text-blue-400 transition-colors">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
                          </svg>
                        </button>
                        <button onClick={() => handleClone(r)} title="Clone rule"
                          className="text-gray-500 hover:text-emerald-400 transition-colors">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                          </svg>
                        </button>
                        <button onClick={() => handleDelete(r.id)} title="Delete rule"
                          className="text-gray-500 hover:text-red-400 transition-colors">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                          </svg>
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {totalPages > 1 && (
        <div className="flex justify-end">
          <Pagination page={pageNum} totalPages={totalPages} onChange={setPage} />
        </div>
      )}
    </div>
  )
}

function UsersTab() {
  const { user: me } = useAuth()
  const [users, setUsers]   = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal]   = useState<'create' | User | null>(null)
  const [confirm, setConfirm] = useState<User | null>(null)
  const [resetPw, setResetPw] = useState<User | null>(null)
  const [error, setError]   = useState('')
  const [userFilter, setUserFilter]     = useState('')
  const [userSortKey, setUserSortKey]   = useState<keyof User | null>(null)
  const [userSortDir, setUserSortDir]   = useState<'asc' | 'desc'>('asc')

  const toggleUserSort = (key: keyof User) => {
    if (userSortKey === key) setUserSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setUserSortKey(key); setUserSortDir('asc') }
  }

  const load = () => {
    setLoading(true)
    api.getUsers().then(setUsers).catch(e => setError(e.message)).finally(() => setLoading(false))
  }

  useEffect(load, [])

  const toggle = async (u: User) => {
    try {
      if (u.is_active) await api.deactivateUser(u.id)
      else             await api.activateUser(u.id)
      load()
    } catch (e: any) { setError(e.message) }
  }

  const del = async (u: User) => {
    try {
      await api.deleteUser(u.id)
      setConfirm(null)
      load()
    } catch (e: any) { setError(e.message) }
  }

  const makeDefaultAdmin = async (u: User) => {
    try {
      await api.setDefaultAdmin(u.id)
      load()
    } catch (e: any) { setError(e.message) }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold text-white">Users</p>
        <HelpButton title="Users — How It Works">
          <p>Three roles: <span className="text-gray-300 font-medium">admin</span> (full access, including this Users tab and all Settings), <span className="text-gray-300 font-medium">analyst</span> (read access plus export — Flow Explorer CSV/JSON, device CSV, etc.), and <span className="text-gray-300 font-medium">viewer</span> (read-only, no export).</p>
          <p>This tab only manages <span className="text-gray-300 font-medium">local accounts</span> — SAML/Okta SSO users are auto-provisioned on first login and managed in Okta itself, not here.</p>
          <p><span className="text-gray-300 font-medium">Deactivate</span> blocks login immediately without deleting the account or its history — prefer it over Delete for someone who's just leaving temporarily, since Delete is permanent.</p>
          <p>The <span className="text-yellow-400">★</span> marks the <span className="text-gray-300 font-medium">default admin</span> — when every auth method in the Auth tab is disabled, the app skips the login page entirely and signs everyone in as this account. Click the star on any active admin to reassign it.</p>
        </HelpButton>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <p className="text-xs text-gray-500">Local accounts only — Okta SSO users are managed in Okta</p>
        <div className="flex items-center gap-2 ml-auto">
          <input
            value={userFilter}
            onChange={e => setUserFilter(e.target.value)}
            placeholder="Filter users…"
            className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 w-40 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          {userFilter && <button onClick={() => setUserFilter('')} className="text-xs text-white hover:text-white">✕</button>}
          <button onClick={() => setModal('create')}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors">
            <span className="text-base leading-none">+</span> Add User
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 text-red-400 text-sm rounded-lg px-4 py-2 flex items-center justify-between">
          {error}
          <button onClick={() => setError('')} className="ml-4 text-red-600 hover:text-red-400">✕</button>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-white text-sm">Loading…</div>
        ) : (
          (() => {
            const USER_COLS: Array<{ label: string; key: keyof User | null; cls?: string }> = [
              { label: 'User',       key: 'username' },
              { label: 'Email',      key: 'email' },
              { label: 'Role',       key: 'role' },
              { label: 'Status',     key: 'is_active' },
              { label: 'Last Login', key: 'last_login' },
              { label: '',           key: null, cls: 'px-5 py-3' },
            ]
            const displayedUsers = users
              .filter(u => {
                if (!userFilter) return true
                const q = userFilter.toLowerCase()
                return u.username.toLowerCase().includes(q) ||
                  u.email.toLowerCase().includes(q) ||
                  u.role.toLowerCase().includes(q)
              })
              .sort((a, b) => {
                if (!userSortKey) return 0
                const av = a[userSortKey] as any
                const bv = b[userSortKey] as any
                if (typeof av === 'boolean') return userSortDir === 'asc' ? (av ? 1 : 0) - (bv ? 1 : 0) : (bv ? 1 : 0) - (av ? 1 : 0)
                if (typeof av === 'number') return userSortDir === 'asc' ? av - bv : bv - av
                return userSortDir === 'asc'
                  ? String(av ?? '').localeCompare(String(bv ?? ''))
                  : String(bv ?? '').localeCompare(String(av ?? ''))
              })
            return (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                {USER_COLS.map(col => (
                  <th
                    key={col.label}
                    onClick={() => col.key && toggleUserSort(col.key)}
                    className={`text-left px-5 py-3 text-xs font-medium uppercase tracking-wider select-none
                      ${col.key ? `cursor-pointer ${userSortKey === col.key ? 'text-blue-400' : 'text-white hover:text-gray-200'}` : (col.cls ?? 'text-white')}`}
                  >
                    {col.label}
                    {userSortKey === col.key && col.key && <span className="ml-1">{userSortDir === 'asc' ? '↑' : '↓'}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/60">
              {displayedUsers.map(u => (
                <tr key={u.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-blue-700/50 flex items-center justify-center text-xs font-bold text-blue-300">
                        {u.username[0].toUpperCase()}
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <p className="text-white font-medium">{u.username}</p>
                          <button
                            onClick={() => !u.is_default_admin && u.role === 'admin' && u.is_active && makeDefaultAdmin(u)}
                            disabled={u.is_default_admin || u.role !== 'admin' || !u.is_active}
                            title={u.is_default_admin
                              ? 'Default admin — auto-logged-in when all auth methods are disabled'
                              : (u.role === 'admin' && u.is_active ? 'Make default admin' : 'Only active admins can be the default admin')}
                            className={`text-sm leading-none ${u.is_default_admin ? 'text-yellow-400' : 'text-gray-500 hover:text-gray-300 disabled:hover:text-gray-500'}`}
                          >
                            {u.is_default_admin ? '★' : '☆'}
                          </button>
                        </div>
                        {u.username === me?.username && <p className="text-xs text-white">you</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-white">{u.email}</td>
                  <td className="px-5 py-3.5">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${roleBadge(u.role)}`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${badge(u.is_active)}`}>
                      {u.is_active ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-white text-xs">
                    {u.last_login
                      // last_login is naive UTC (SQLite datetime('now'), no 'Z') —
                      // normalize before parsing so it isn't misread as local time.
                      ? new Date(u.last_login.includes('T') || u.last_login.endsWith('Z') ? u.last_login : u.last_login.replace(' ', 'T') + 'Z').toLocaleString()
                      : 'Never'}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => setResetPw(u)} title="Reset Password"
                        className="p-1.5 text-white hover:text-purple-400 hover:bg-purple-900/20 rounded transition-colors">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/>
                        </svg>
                      </button>
                      <button onClick={() => setModal(u)} title="Edit"
                        className="p-1.5 text-white hover:text-blue-400 hover:bg-blue-900/20 rounded transition-colors">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"/>
                        </svg>
                      </button>
                      {u.username !== me?.username && (
                        <button onClick={() => toggle(u)} title={u.is_active ? 'Disable' : 'Enable'}
                          className={`p-1.5 rounded transition-colors ${
                            u.is_active
                              ? 'text-white hover:text-yellow-400 hover:bg-yellow-900/20'
                              : 'text-white hover:text-green-400 hover:bg-green-900/20'
                          }`}>
                          {u.is_active
                            ? <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg>
                            : <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                          }
                        </button>
                      )}
                      {u.username !== me?.username && (
                        <button onClick={() => setConfirm(u)} title="Delete"
                          className="p-1.5 text-white hover:text-red-400 hover:bg-red-900/20 rounded transition-colors">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/>
                          </svg>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
            )
          })()
        )}
      </div>

      <p className="text-xs text-white">
        Roles: <strong className="text-white">admin</strong> — full access &nbsp;·&nbsp;
        <strong className="text-white">analyst</strong> — read + export &nbsp;·&nbsp;
        <strong className="text-white">viewer</strong> — read-only
      </p>

      {resetPw && <ResetPasswordModal user={resetPw} onClose={() => setResetPw(null)} />}

      {modal !== null && (
        <UserModal
          user={modal === 'create' ? null : modal}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }}
        />
      )}

      {confirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full">
            <h3 className="text-white font-semibold mb-2">Delete user?</h3>
            <p className="text-white text-sm mb-5">
              <strong className="text-white">{confirm.username}</strong> will be permanently removed.
              This cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirm(null)}
                className="px-4 py-2 text-sm text-white hover:text-white">Cancel</button>
              <button onClick={() => del(confirm)}
                className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
