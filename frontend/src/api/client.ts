/**
 * pktFlow API client — typed fetch wrappers.
 * Access token is stored in memory (not localStorage).
 */

let _accessToken: string | null = null
let _tokenRole: string | null = null

export function setToken(token: string, role: string) {
  _accessToken = token
  _tokenRole = role
}

export function clearToken() {
  _accessToken = null
  _tokenRole = null
}

export function getRole(): string | null {
  return _tokenRole
}

export function isAuthenticated(): boolean {
  return _accessToken !== null
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }

  if (_accessToken) {
    headers['Authorization'] = `Bearer ${_accessToken}`
  }

  const res = await fetch(`/api${path}`, { ...options, headers })

  if (res.status === 401) {
    // Try silent refresh
    const refreshed = await tryRefresh()
    if (refreshed) {
      headers['Authorization'] = `Bearer ${_accessToken}`
      const retry = await fetch(`/api${path}`, { ...options, headers })
      if (!retry.ok) throw new Error(`${retry.status} ${retry.statusText}`)
      return retry.json()
    }
    clearToken()
    window.location.href = '/login'
    throw new Error('Session expired')
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || res.statusText)
  }

  if (res.status === 204) return null as T
  return res.json()
}

async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
    if (!res.ok) return false
    const data = await res.json()
    setToken(data.access_token, data.role)
    return true
  } catch {
    return false
  }
}

export const api = {
  // Auth
  login: (username: string, password: string) =>
    request<{ access_token: string; role: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request('/auth/logout', { method: 'POST' }),

  // Flows
  getDeviceSummaries: () => request<DeviceSummary[]>('/flows/devices'),
  getFlowRate: () => request<{ flows_per_sec: number }>('/flows/rate'),
  getTimeSeries: (params: TimeSeriesParams) =>
    request<TimeSeriesPoint[]>(`/flows/timeseries?${new URLSearchParams(params as any)}`),
  getTopTalkers: (params: TopTalkersParams) =>
    request<TopTalker[]>(`/flows/top-talkers?${new URLSearchParams(params as any)}`),
  searchFlows: (params: SearchParams) =>
    request<FlowRecord[]>(`/flows/search?${new URLSearchParams(params as any)}`),
  getLastSeen: () => request<Record<string, string>>('/flows/last-seen'),
  getTopology: (params: TopologyParams) =>
    request<TopologyResponse>(`/flows/topology?${new URLSearchParams(params as any)}`),

  // Devices
  getDevices: () => request<Device[]>('/devices/'),
  createDevice: (d: DeviceIn) => request<Device>('/devices/', { method: 'POST', body: JSON.stringify(d) }),
  updateDevice: (id: number, d: DeviceIn) =>
    request<Device>(`/devices/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
  deleteDevice: (id: number) => request(`/devices/${id}`, { method: 'DELETE' }),

  // Alerts
  getAlertRules: () => request<AlertRule[]>('/alerts/rules'),
  getAlertEvents: (unackedOnly = false) =>
    request<AlertEvent[]>(`/alerts/events?unacked_only=${unackedOnly}`),
  ackEvent: (id: number) => request(`/alerts/events/${id}/ack`, { method: 'POST' }),
  ackAllEvents: () => request('/alerts/events/ack-all', { method: 'POST' }),

  // Settings
  getSettings: () => request<Record<string, unknown>>('/settings/'),
  updateSetting: (key: string, value: unknown) =>
    request(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  bulkUpdateSettings: (updates: Record<string, unknown>) =>
    request('/settings/bulk', { method: 'POST', body: JSON.stringify(updates) }),

  // Users
  getUsers: () => request<User[]>('/users/'),
  getMe: () => request<User>('/users/me'),
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DeviceSummary {
  sampler_ip: string
  sampler_name: string
  site: string
  bytes_last_hour: number
  packets_last_hour: number
  flows_last_hour: number
  flows_per_sec: number
  last_seen: string | null
}

export interface TimeSeriesPoint {
  timestamp: string
  bytes: number
  packets: number
  flow_count: number
}

export interface TopTalker {
  src_ip: string
  dst_ip: string
  dst_port: number
  protocol: number
  bytes: number
  packets: number
  flow_count: number
}

export interface FlowRecord {
  timestamp: string
  sampler_ip: string
  sampler_name: string
  src_ip: string
  dst_ip: string
  src_port: number
  dst_port: number
  protocol: number
  bytes: number
  packets: number
  duration_ms: number
}

export interface Device {
  id: number
  ip: string
  name: string
  site: string
  notes: string
  allowed: boolean
  created_at: string
  updated_at: string
}

export interface DeviceIn {
  ip: string; name: string; site: string; notes: string; allowed: boolean
}

export interface AlertRule {
  id: number
  name: string
  description: string
  enabled: boolean
  rule_type: string
  conditions: Record<string, unknown>
  severity: string
  channels: string[]
  cooldown_min: number
  last_fired: string | null
}

export interface AlertEvent {
  id: number
  rule_id: number
  rule_name: string
  severity: string
  message: string
  details: Record<string, unknown>
  fired_at: string
  acked_at: string | null
}

export interface User {
  id: number
  username: string
  email: string
  role: string
  is_active: boolean
  created_at: string
  last_login: string | null
}

export interface TopologyNode {
  id: string
  sampler_name: string
  site: string
  bytes: number
  flows: number
  is_sampler: boolean
}

export interface TopologyEdge {
  source: string
  target: string
  bytes: number
  packets: number
  flows: number
  protocol: number
  dst_port: number
}

export interface TopologyResponse {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
}

export type TopologyParams = { window?: string; sampler_ip?: string; min_bytes?: string; limit?: string }
export type TimeSeriesParams = { sampler_ip?: string; window?: string }
export type TopTalkersParams = { sampler_ip?: string; window?: string; limit?: string }
export type SearchParams = {
  src_ip?: string; dst_ip?: string; src_port?: string; dst_port?: string
  protocol?: string; sampler_ip?: string; window?: string; limit?: string
}

/**
 * Download a binary/text export from an authenticated API endpoint.
 * Triggers browser Save dialog. Returns an error string or null on success.
 */
export async function downloadExport(
  path: string,
  params: Record<string, string>,
  filename: string,
): Promise<string | null> {
  const qs = new URLSearchParams(params).toString()
  const url = `/api${path}${qs ? '?' + qs : ''}`
  const headers: Record<string, string> = {}
  if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
  try {
    const res = await fetch(url, { headers })
    if (!res.ok) return `Export failed: ${res.status} ${res.statusText}`
    const blob = await res.blob()
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(href)
    return null
  } catch (e) {
    return String(e)
  }
}
