import { useEffect, useState } from 'react'
import { api, AlertRule, AlertEvent } from '../api/client'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(ts: string): string {
  return new Date(ts).toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

const SEV_STYLES: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-400 border border-red-500/40',
  warning:  'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40',
  info:     'bg-blue-500/20 text-blue-400 border border-blue-500/40',
}

const CHANNELS_AVAILABLE = ['inapp', 'slack', 'email', 'pagerduty', 'webhook']
const RULE_TYPES = ['threshold', 'rate_spike', 'new_host', 'data_gap', 'port_protocol']

// ── Alert event card ──────────────────────────────────────────────────────────
function EventCard({ event, onAck }: { event: AlertEvent; onAck: (id: number) => void }) {
  const [expanded, setExpanded] = useState(false)
  const isAcked     = Boolean(event.acked_at)
  const isResolved  = Boolean(event.resolved_at) && !isAcked

  return (
    <div className={`bg-gray-900 border rounded-xl p-4 transition-opacity ${
      isAcked ? 'opacity-40 border-gray-800' : isResolved ? 'opacity-70 border-gray-700' : 'border-gray-700'
    }`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium capitalize ${SEV_STYLES[event.severity] ?? SEV_STYLES.info}`}>
            {event.severity}
          </span>
          {isResolved && (
            <span className="shrink-0 text-xs px-2 py-0.5 rounded-full font-medium bg-green-500/20 text-green-400 border border-green-500/40">
              auto-resolved
            </span>
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium text-white truncate">{event.rule_name}</p>
            <p className="text-sm text-white mt-0.5">{event.message}</p>
            {isResolved && (
              <p className="text-xs text-green-500/70 mt-0.5">Resolved {fmtTime(event.resolved_at!)}</p>
            )}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <span className="text-xs text-white">{fmtTime(event.fired_at)}</span>
          {!isAcked && (
            <button
              onClick={() => onAck(event.id)}
              className="text-xs bg-gray-800 hover:bg-gray-700 text-white hover:text-white border border-gray-700 rounded px-2.5 py-1 transition-colors"
            >
              Ack
            </button>
          )}
          {isAcked && <span className="text-xs text-green-500">✓ Acked</span>}
        </div>
      </div>

      {Object.keys(event.details).length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-xs text-white hover:text-white transition-colors"
          >
            {expanded ? '▾ Hide details' : '▸ Show details'}
          </button>
          {expanded && (
            <pre className="mt-2 text-xs bg-gray-800 rounded-lg p-3 text-white overflow-x-auto">
              {JSON.stringify(event.details, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

// ── Rule form ─────────────────────────────────────────────────────────────────
interface RuleFormData {
  name: string; description: string; enabled: boolean; rule_type: string
  severity: string; channels: string[]; cooldown_min: string; time_window_min: string
}

const EMPTY_RULE: RuleFormData = {
  name: '', description: '', enabled: true, rule_type: 'data_gap',
  severity: 'warning', channels: ['inapp'], cooldown_min: '30', time_window_min: '5',
}

function fromRule(r: AlertRule): RuleFormData {
  return {
    name: r.name, description: r.description, enabled: r.enabled,
    rule_type: r.rule_type, severity: r.severity,
    channels: r.channels, cooldown_min: String(r.cooldown_min),
    time_window_min: '5',
  }
}

function RuleForm({
  initial, onSave, onCancel, saving,
}: {
  initial: RuleFormData
  onSave: (data: RuleFormData) => Promise<void>
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState<RuleFormData>(initial)
  const set = <K extends keyof RuleFormData>(k: K, v: RuleFormData[K]) =>
    setForm(f => ({ ...f, [k]: v }))

  const toggleChannel = (ch: string) => {
    set('channels', form.channels.includes(ch)
      ? form.channels.filter(c => c !== ch)
      : [...form.channels, ch])
  }

  return (
    <div className="bg-gray-900 border border-blue-500/30 rounded-xl p-5 space-y-4">
      <h3 className="text-sm font-semibold text-white">{initial.name ? 'Edit rule' : 'New alert rule'}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <label className="block text-xs text-white mb-1">Rule name</label>
          <input
            value={form.name}
            onChange={e => set('name', e.target.value)}
            placeholder="My alert rule"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs text-white mb-1">Description (optional)</label>
          <input
            value={form.description}
            onChange={e => set('description', e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs text-white mb-1">Rule type</label>
          <select
            value={form.rule_type}
            onChange={e => set('rule_type', e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {RULE_TYPES.map(t => (
              <option key={t} value={t}>{t.replace('_', ' ')}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-white mb-1">Severity</label>
          <select
            value={form.severity}
            onChange={e => set('severity', e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-white mb-1">Cooldown (minutes)</label>
          <input
            type="number" min="1" max="1440"
            value={form.cooldown_min}
            onChange={e => set('cooldown_min', e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs text-white mb-1">Eval window (minutes)</label>
          <input
            type="number" min="1" max="1440"
            value={form.time_window_min}
            onChange={e => set('time_window_min', e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs text-white mb-2">Notification channels</label>
        <div className="flex flex-wrap gap-2">
          {CHANNELS_AVAILABLE.map(ch => {
            const active = form.channels.includes(ch)
            return (
              <button
                key={ch}
                type="button"
                onClick={() => toggleChannel(ch)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-colors capitalize ${
                  active
                    ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                    : 'bg-gray-800 border-gray-700 text-white hover:border-gray-500'
                }`}
              >
                {ch}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={() => onSave(form)}
          disabled={saving || !form.name.trim()}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors"
        >
          {saving ? 'Saving…' : 'Save rule'}
        </button>
        <button
          onClick={onCancel}
          className="text-white hover:text-white text-sm border border-gray-700 rounded-lg px-4 py-2 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
type Tab = 'active' | 'history' | 'rules'

export default function Alerts() {
  const [tab, setTab]               = useState<Tab>('active')
  const [events, setEvents]         = useState<AlertEvent[]>([])
  const [history, setHistory]       = useState<AlertEvent[]>([])
  const [rules, setRules]           = useState<AlertRule[]>([])
  const [loading, setLoading]       = useState(false)
  const [editRule, setEditRule]     = useState<AlertRule | null>(null)
  const [addingRule, setAddingRule] = useState(false)
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState('')

  const loadEvents = async () => {
    setLoading(true)
    try {
      const [active, all] = await Promise.all([
        api.getAlertEvents(true),
        api.getAlertEvents(false),
      ])
      setEvents(active)
      setHistory(all.filter(e => e.acked_at !== null))
    } finally {
      setLoading(false)
    }
  }

  const loadRules = async () => {
    const data = await api.getAlertRules()
    setRules(data)
  }

  useEffect(() => {
    loadEvents()
    loadRules()
  }, [])

  const handleAck = async (id: number) => {
    await api.ackEvent(id)
    await loadEvents()
  }

  const handleAckAll = async () => {
    await api.ackAllEvents()
    await loadEvents()
  }

  const handleToggle = async (rule: AlertRule) => {
    setRules(rs => rs.map(r => r.id === rule.id ? { ...r, enabled: !r.enabled } : r))
    try {
      const res = await fetch(`/api/alerts/rules/${rule.id}/toggle`, { method: 'PATCH' })
      if (!res.ok) throw new Error()
    } catch {
      setRules(rs => rs.map(r => r.id === rule.id ? { ...r, enabled: rule.enabled } : r))
    }
  }

  const handleDeleteRule = async (id: number) => {
    if (!confirm('Delete this alert rule?')) return
    await fetch(`/api/alerts/rules/${id}`, { method: 'DELETE' })
    await loadRules()
  }

  const handleSaveRule = async (form: RuleFormData) => {
    setSaving(true)
    setError('')
    try {
      const body = {
        name: form.name, description: form.description, enabled: form.enabled,
        rule_type: form.rule_type, conditions: {},
        time_window_min: parseInt(form.time_window_min) || 5,
        severity: form.severity, channels: form.channels,
        cooldown_min: parseInt(form.cooldown_min) || 30,
      }
      if (editRule) {
        await fetch(`/api/alerts/rules/${editRule.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        setEditRule(null)
      } else {
        await fetch('/api/alerts/rules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        setAddingRule(false)
      }
      await loadRules()
    } catch {
      setError('Failed to save rule')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Alerts</h1>
          <p className="text-sm text-white mt-0.5">
            {(() => {
              const active   = events.filter(e => !e.resolved_at).length
              const resolved = events.filter(e => e.resolved_at).length
              if (active > 0)
                return `${active} active alert${active !== 1 ? 's' : ''}${resolved > 0 ? `, ${resolved} auto-resolved` : ''}`
              if (resolved > 0)
                return `${resolved} auto-resolved alert${resolved !== 1 ? 's' : ''} — all conditions cleared`
              return 'No active alerts'
            })()}
          </p>
        </div>
        {tab === 'active' && events.length > 0 && (
          <button
            onClick={handleAckAll}
            className="text-sm border border-gray-700 hover:border-gray-500 text-white hover:text-white rounded-lg px-4 py-2 transition-colors"
          >
            Ack all
          </button>
        )}
        {tab === 'rules' && !addingRule && !editRule && (
          <button
            onClick={() => setAddingRule(true)}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >
            + New rule
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {(['active', 'history', 'rules'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-sm px-4 py-1.5 rounded-lg transition-colors capitalize ${
              tab === t ? 'bg-gray-700 text-white' : 'text-white hover:text-white'
            }`}
          >
            {t}
            {t === 'active' && events.filter(e => !e.resolved_at).length > 0 && (
              <span className="ml-1.5 bg-red-500 text-white text-xs rounded-full px-1.5 py-0.5">
                {events.filter(e => !e.resolved_at).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Active events */}
      {tab === 'active' && (
        <div className="space-y-3">
          {loading && <p className="text-sm text-white">Loading…</p>}
          {!loading && events.length === 0 && (
            <div className="flex flex-col items-center justify-center h-32 text-white">
              <p className="text-2xl mb-2">✓</p>
              <p className="text-sm">No unacknowledged alerts</p>
            </div>
          )}
          {events.map(e => <EventCard key={e.id} event={e} onAck={handleAck} />)}
        </div>
      )}

      {/* History */}
      {tab === 'history' && (
        <div className="space-y-3">
          {history.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center h-32 text-white">
              <p className="text-sm">No alert history</p>
            </div>
          )}
          {history.map(e => <EventCard key={e.id} event={e} onAck={handleAck} />)}
        </div>
      )}

      {/* Rules */}
      {tab === 'rules' && (
        <div className="space-y-4">
          {addingRule && (
            <RuleForm
              initial={EMPTY_RULE}
              onSave={handleSaveRule}
              onCancel={() => setAddingRule(false)}
              saving={saving}
            />
          )}
          {editRule && (
            <RuleForm
              initial={fromRule(editRule)}
              onSave={handleSaveRule}
              onCancel={() => setEditRule(null)}
              saving={saving}
            />
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  {['Enabled', 'Rule', 'Type', 'Severity', 'Channels', 'Cooldown', ''].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-white">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {rules.map(rule => (
                  <tr key={rule.id} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleToggle(rule)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                          rule.enabled ? 'bg-blue-600' : 'bg-gray-700'
                        }`}
                      >
                        <span className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
                          rule.enabled ? 'translate-x-5' : 'translate-x-1'
                        }`} />
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-white">{rule.name}</p>
                      {rule.description && (
                        <p className="text-xs text-white mt-0.5">{rule.description}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-white text-xs">
                      <span className="bg-gray-800 px-2 py-0.5 rounded">{rule.rule_type}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${SEV_STYLES[rule.severity] ?? SEV_STYLES.info}`}>
                        {rule.severity}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-white">{rule.channels.join(', ')}</td>
                    <td className="px-4 py-3 text-xs text-white">{rule.cooldown_min}m</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => { setEditRule(rule); setAddingRule(false) }}
                          className="text-xs text-white hover:text-blue-400 transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteRule(rule.id)}
                          className="text-xs text-white hover:text-red-400 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {rules.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-sm text-white">
                      No alert rules yet — click "+ New rule" to add one
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
