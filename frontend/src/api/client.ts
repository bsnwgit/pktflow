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

export function getToken(): string | null {
  return _accessToken
}

/** Role value — for passing to pop-out windows via sessionStorage. */
export function getTokenRole(): string | null { return _tokenRole }

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
  // Deliberately bypasses request() — a bad password here is a normal login
  // failure, not an expired session, and must not trigger the 401 handler's
  // refresh-then-redirect-to-/login flow (that would hard-reload the login
  // page itself before the error message is even visible).
  login: async (username: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || res.statusText)
    }
    return res.json() as Promise<{ access_token: string; role: string }>
  },
  // Deliberately bypasses request() for the same reason as login() above.
  autoLogin: async () => {
    const res = await fetch('/api/auth/auto-login', { method: 'POST' })
    if (!res.ok) throw new Error('Auto-login not available')
    return res.json() as Promise<{ access_token: string; role: string }>
  },
  logout: () => request('/auth/logout', { method: 'POST' }),

  getDeviceSummaries: () => request<DeviceSummary[]>('/flows/devices'),
  purgeSampler: (sampler_ip: string) =>
    request<null>(`/flows/samplers/${encodeURIComponent(sampler_ip)}`, { method: 'DELETE' }),
  getFlowRate: () => request<{ flows_per_sec: number }>('/flows/rate'),
  getTimeSeries: (params: TimeSeriesParams) =>
    request<TimeSeriesPoint[]>(`/flows/timeseries?${new URLSearchParams(params as any)}`),
  getTopTalkers: (params: TopTalkersParams) =>
    request<TopTalker[]>(`/flows/top-talkers?${new URLSearchParams(params as any)}`),
  searchFlows: (params: SearchParams) =>
    request<FlowRecord[]>(`/flows/search?${new URLSearchParams(params as any)}`),
  countFlows: (params: SearchParams) =>
    request<{ total: number }>(`/flows/search/count?${new URLSearchParams(params as any)}`),
  getLastSeen: () => request<Record<string, string>>('/flows/last-seen'),
  getTopology: (params: TopologyParams) =>
    request<TopologyResponse>(`/flows/topology?${new URLSearchParams(params as any)}`),
  getGeoData: (window: string, sampler_ip?: string) =>
    request<GeoDataResponse>(`/flows/geo?window=${window}${sampler_ip ? `&sampler_ip=${sampler_ip}` : ''}`),
  getProtocolStats: (params: { window?: string; sampler_ip?: string }) =>
    request<ProtocolStat[]>(`/flows/protocols?${new URLSearchParams(params as any)}`),
  getTopPorts: (params: TopPortsParams) =>
    request<PortStat[]>(`/flows/ports/top?${new URLSearchParams(params as any)}`),
  getNatTranslations: (params: NatTranslationsParams) =>
    request<NatTranslation[]>(`/flows/nat-translations?${new URLSearchParams(params as any)}`),
  getDailyTimeseries: (days: number, sampler_ip?: string) =>
    request<TimeSeriesPoint[]>(`/flows/timeseries/daily?days=${days}${sampler_ip ? `&sampler_ip=${sampler_ip}` : ''}`),
  getHourlyTimeseries: (window: string, sampler_ip?: string) =>
    request<TimeSeriesPoint[]>(`/flows/timeseries/hourly?window=${window}${sampler_ip ? `&sampler_ip=${sampler_ip}` : ''}`),

  getDevices: () => request<Device[]>('/devices/'),
  createDevice: (d: DeviceIn) => request<Device>('/devices/', { method: 'POST', body: JSON.stringify(d) }),
  updateDevice: (id: number, d: DeviceIn) =>
    request<Device>(`/devices/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
  deleteDevice: (id: number) => request(`/devices/${id}`, { method: 'DELETE' }),
  getUnknownSamplers: () =>
    request<{ unknown: Array<{ sampler_ip: string; flows_per_sec: number; last_seen: string }>; dismissed: Array<{ sampler_ip: string; dismissed_at: string }> }>('/devices/unknown-samplers'),
  getDeviceSites: () => request<string[]>('/devices/sites'),
  dismissSampler: (ip: string) => request<{ dismissed: string }>(`/devices/dismiss/${encodeURIComponent(ip)}`, { method: 'POST' }),
  undismissSampler: (ip: string) => request<null>(`/devices/dismiss/${encodeURIComponent(ip)}`, { method: 'DELETE' }),

  getAlertRules: () => request<AlertRule[]>('/alerts/rules'),
  getAlertEvents: (unackedOnly = false, since?: string, until?: string) => {
    const p = new URLSearchParams({ unacked_only: String(unackedOnly) })
    if (since) p.set('since', since)
    if (until) p.set('until', until)
    return request<AlertEvent[]>(`/alerts/events?${p.toString()}`)
  },
  ackEvent: (id: number) => request(`/alerts/events/${id}/ack`, { method: 'POST' }),
  ackAllEvents: () => request('/alerts/events/ack-all', { method: 'POST' }),

  getSettings: () => request<Record<string, unknown>>('/settings/'),
  updateSetting: (key: string, value: unknown) =>
    request(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  bulkUpdateSettings: (updates: Record<string, unknown>) =>
    request('/settings/bulk', { method: 'POST', body: JSON.stringify(updates) }),
  testNotification: (channel: string) =>
    request<{ status: string; detail: string }>('/settings/test-notification', {
      method: 'POST',
      body: JSON.stringify({ channel }),
    }),

  getUsers: () => request<User[]>('/users/'),
  getMe: () => request<User>('/users/me'),
  createUser: (body: UserIn) => request<User>('/users/', { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (id: number, body: UserIn) => request<User>(`/users/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteUser: (id: number) => request(`/users/${id}`, { method: 'DELETE' }),
  activateUser: (id: number) => request(`/users/${id}/activate`, { method: 'PATCH' }),
  deactivateUser: (id: number) => request(`/users/${id}/deactivate`, { method: 'PATCH' }),
  setDefaultAdmin: (id: number) => request(`/users/${id}/set-default-admin`, { method: 'PATCH' }),
  resetUserPassword: (id: number, newPassword: string) =>
    request(`/users/${id}/reset-password`, { method: 'PATCH', body: JSON.stringify({ new_password: newPassword }) }),
  changeMyPassword: (currentPassword: string, newPassword: string) =>
    request('/users/me/password', { method: 'PATCH', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) }),

  testStorageConnection: () =>
    request<{ ok: boolean; backend: string; message: string }>('/system/test-connection', { method: 'POST' }),

  getSuiteToken: () =>
    request<{ suite_token: string; has_token: boolean }>('/suite/token'),

  restartService: () =>
    request<{ status: string; message: string }>('/system/restart', { method: 'POST' }),
  getPort: () =>
    request<{ port: number }>('/system/port'),
  setPort: (port: number) =>
    request<{ port: number; message: string }>('/system/port', {
      method: 'POST',
      body: JSON.stringify({ port }),
    }),

  runCleanup: () =>
    request<{
      flows_eligible: number
      hourly_eligible: number
      alert_events_deleted: number
      notification_log_deleted: number
      clickhouse_status: string
      status: string
    }>('/system/cleanup', { method: 'POST' }),

  runBackupNow: () =>
    request<{ status: string; path: string; files: string[]; kept: number }>('/system/backup', { method: 'POST' }),

  listBackups: () =>
    request<Array<{ name: string; path: string; size_bytes: number; files: string[] }>>('/system/backup/list'),

  importBundle: async (file: File, files?: string[]): Promise<Record<string, string>> => {
    const formData = new FormData()
    formData.append('file', file)
    if (files) formData.append('files', files.join(','))
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch('/api/system/import', { method: 'POST', headers, body: formData })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || res.statusText)
    }
    return res.json()
  },
  restoreSnapshot: (name: string, files?: string[]): Promise<Record<string, string>> => {
    const qs = files && files.length ? `?files=${encodeURIComponent(files.join(','))}` : ''
    return request<Record<string, string>>(`/system/backup/restore/${encodeURIComponent(name)}${qs}`, { method: 'POST' })
  },

  exportConfig: async (): Promise<{ blob: Blob; filename: string }> => {
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch('/api/system/export', { headers })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const blob = await res.blob()
    const cd = res.headers.get('Content-Disposition') ?? ''
    const match = cd.match(/filename="([^"]+)"/)
    const filename = match ? match[1] : 'pktflow-export.tar.gz'
    return { blob, filename }
  },

  createLucidchart: (params: URLSearchParams) =>
    request<{ edit_url: string; document_id: string }>(
      `/flows/topology/lucidchart?${params}`,
      { method: 'POST' }
    ),

  getUserApiKeys: () => request<UserApiKey[]>('/user-api-keys'),
  setUserApiKey: (provider: string, api_key: string) =>
    request<UserApiKey>(`/user-api-keys/${provider}`, { method: 'PUT', body: JSON.stringify({ api_key }) }),
  testUserApiKey: (provider: string, api_key: string) =>
    request<{ status: string; detail: string }>(`/user-api-keys/${provider}/test`, { method: 'POST', body: JSON.stringify({ api_key }) }),
  setIpinfoFields: (enabled_fields: string[]) =>
    request<UserApiKey>('/user-api-keys/ipinfo/fields', { method: 'PUT', body: JSON.stringify({ enabled_fields }) }),
  setIpapiIsFields: (enabled_fields: string[]) =>
    request<UserApiKey>('/user-api-keys/ipapi_is/fields', { method: 'PUT', body: JSON.stringify({ enabled_fields }) }),
  setIpapiIsFreeTier: (free_tier: boolean) =>
    request<UserApiKey>('/user-api-keys/ipapi_is/free-tier', { method: 'PUT', body: JSON.stringify({ free_tier }) }),
  setMxtoolboxFields: (enabled_fields: string[]) =>
    request<UserApiKey>('/user-api-keys/mxtoolbox/fields', { method: 'PUT', body: JSON.stringify({ enabled_fields }) }),
  setProviderEnabled: (provider: string, enabled: boolean) =>
    request<UserApiKey>(`/user-api-keys/${provider}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  getIpInfo: (ip: string) => request<IpInfoResult>(`/ip-info/${ip}`),
  getInternalIpInfo: (ip: string) => request<InternalIpInfoResult>(`/ip-info/internal/${ip}`),
  getAsnInfo: (asn: string) => request<AsnInfoResult>(`/ip-info/asn/${asn}`),

  getIntegrations: () => request<Integration[]>('/integrations'),
  createIntegration: (body: IntegrationInput) =>
    request<Integration>('/integrations', { method: 'POST', body: JSON.stringify(body) }),
  updateIntegration: (id: number, body: Partial<IntegrationInput>) =>
    request<Integration>(`/integrations/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteIntegration: (id: number) => request(`/integrations/${id}`, { method: 'DELETE' }),
  testIntegration: (id: number) => request<{ healthy: boolean; detail: string }>(`/integrations/${id}/test`, { method: 'POST' }),

  getSslStatus: () => request<SslStatus>('/system/ssl/status'),
  uploadSsl: async (cert: File, key: File): Promise<SslStatus> => {
    const formData = new FormData()
    formData.append('cert', cert)
    formData.append('key', key)
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch('/api/system/ssl/upload', { method: 'POST', headers, body: formData })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || res.statusText)
    }
    return res.json()
  },
  deleteSsl: () => request<SslStatus>('/system/ssl/cert', { method: 'DELETE' }),
  uploadSslPfx: async (pfx: File, passphrase: string): Promise<SslStatus> => {
    const formData = new FormData()
    formData.append('pfx', pfx)
    formData.append('passphrase', passphrase)
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch('/api/system/ssl/upload-pfx', { method: 'POST', headers, body: formData })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || res.statusText)
    }
    return res.json()
  },

  exportDevicesCsv: async (): Promise<void> => {
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch('/api/devices/export', { headers })
    if (!res.ok) throw new Error(`Export failed: ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'pktflow-devices.csv'
    a.click()
    URL.revokeObjectURL(url)
  },

  importDevicesCsv: async (file: File): Promise<{ created: number; updated: number; skipped: number; errors: Array<{ row: number; reason: string }> }> => {
    const formData = new FormData()
    formData.append('file', file)
    const headers: Record<string, string> = {}
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`
    const res = await fetch('/api/devices/import', { method: 'POST', headers, body: formData })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || res.statusText)
    }
    return res.json()
  },

  getNatMappings: () =>
    request<NatMapping[]>('/nat-mappings/'),
  createNatMapping: (body: NatMappingIn) =>
    request<NatMapping>('/nat-mappings/', { method: 'POST', body: JSON.stringify(body) }),
  updateNatMapping: (id: number, body: NatMappingIn) =>
    request<NatMapping>(`/nat-mappings/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  reorderNatMappings: (ids: number[]) =>
    request<NatMapping[]>('/nat-mappings/reorder', { method: 'POST', body: JSON.stringify({ ids }) }),
  deleteNatMapping: (id: number) =>
    request(`/nat-mappings/${id}`, { method: 'DELETE' }),

  getTrafficRules: () =>
    request<TrafficRule[]>('/traffic-rules/'),
  createTrafficRule: (body: TrafficRuleIn) =>
    request<TrafficRule>('/traffic-rules/', { method: 'POST', body: JSON.stringify(body) }),
  updateTrafficRule: (id: number, body: TrafficRuleIn) =>
    request<TrafficRule>(`/traffic-rules/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  reorderTrafficRules: (ids: number[]) =>
    request<TrafficRule[]>('/traffic-rules/reorder', { method: 'POST', body: JSON.stringify({ ids }) }),
  deleteTrafficRule: (id: number) =>
    request(`/traffic-rules/${id}`, { method: 'DELETE' }),

  // ── Documentation ─────────────────────────────────────────────────────────
  getDocs: () => request<{ slug: string; title: string }[]>('/docs-content'),
  getDoc: (slug: string) =>
    request<{ slug: string; title: string; content: string }>(`/docs-content/${slug}`),

  // ── Geo Map config ─────────────────────────────────────────────────────────
  getSites: () =>
    request<Site[]>('/geo-config/sites'),
  createSite: (body: SiteIn) =>
    request<Site>('/geo-config/sites', { method: 'POST', body: JSON.stringify(body) }),
  updateSite: (id: number, body: SiteIn) =>
    request<Site>(`/geo-config/sites/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteSite: (id: number) =>
    request(`/geo-config/sites/${id}`, { method: 'DELETE' }),

  getLineStyles: () =>
    request<LineStyle[]>('/geo-config/line-styles'),
  createLineStyle: (body: LineStyleIn) =>
    request<LineStyle>('/geo-config/line-styles', { method: 'POST', body: JSON.stringify(body) }),
  updateLineStyle: (id: number, body: LineStyleIn) =>
    request<LineStyle>(`/geo-config/line-styles/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteLineStyle: (id: number) =>
    request(`/geo-config/line-styles/${id}`, { method: 'DELETE' }),

  getLogs: (params: LogQueryParams) =>
    request<LogResponse>(`/logs?${new URLSearchParams(params as any)}`),

  getLogStats: () =>
    request<LogStats>('/logs/stats'),

  clearLogs: () =>
    request<{ status: string }>('/logs', { method: 'DELETE' }),

  setLogLevel: (level: string) =>
    request<{ status: string; level: string }>(`/logs/level?level=${level}`, { method: 'POST' }),
}

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
  tcp_flags?: number
  tos?: number
  input_if?: number
  output_if?: number
  next_hop?: string
  src_as?: number
  dst_as?: number
  flow_dir?: number
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
  resolved_at: string | null
  auto_resolved: number  // 1 = engine auto-resolved, 0 = not
}

export interface UserIn {
  username: string
  email: string
  password?: string
  role: string
}

export interface User {
  id: number
  username: string
  email: string
  role: string
  is_active: boolean
  is_default_admin: boolean
  created_at: string
  last_login: string | null
  has_password: boolean
  auth_provider: string
}

export interface SslStatus {
  installed: boolean
  expires?: string
  expires_iso?: string
  days_until_expiry?: number
  subject?: string
  issuer?: string
  error?: string
  status?: string
}

export interface ProtocolStat {
  protocol: number
  name: string
  bytes: number
  packets: number
  flow_count: number
  pct_bytes: number
}

export interface PortStat {
  port: number
  protocol: number
  proto_name: string
  service_name: string
  bytes: number
  packets: number
  flow_count: number
  pct_bytes: number
}

export interface NatTranslation {
  sampler_ip: string
  sampler_name: string
  direction: 'src' | 'dst'
  original_ip: string
  translated_ip: string
  flow_count: number
  bytes: number
  first_seen: string
  last_seen: string
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
  bytes_fwd: number      // source→target bytes
  bytes_rev: number      // target→source bytes
  is_asymmetric: boolean // one side sent >10× the other
  sampler_ip: string     // dominant NetFlow exporter that observed this pair
}

export interface TopologyResponse {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
}

export interface GeoLocation {
  ip: string; lat: number; lng: number
  city: string; country: string; country_code: string
  bytes: number; flows: number
  site_name?: string   // set when the IP matched an Address Mapping or a Site's ip_cidr (e.g. "Site A", "Cloud AWS")
  site_key?: string    // site key (configured in Settings → Geo Map → Sites), or "" when unmapped
}
export interface GeoArc {
  src_ip: string; src_lat: number; src_lng: number
  dst_ip: string; dst_lat: number; dst_lng: number
  bytes: number; flows: number
  color: string           // resolved line color, set by backend (gray default when unmapped)
  dash:  string            // resolved stroke-dasharray, '' = solid
  label: string | null     // name of the Traffic Rule that assigned this style, null when unmatched (default gray)
}
export interface GeoDataResponse {
  locations: GeoLocation[]
  arcs: GeoArc[]
}

export interface NatMapping {
  id:             number
  name:           string
  site_key:       string
  category:       'wan' | 'vpn'   // display badge only, no effect on matching
  private_cidr:   string
  public_cidr:    string
  dst_cidrs:      string | null   // comma-separated IPs/CIDRs; blank = any destination — lets this private_cidr resolve differently by destination
  dst_ports:      string | null   // comma-separated ports/ranges; blank = any port
  priority:       number          // lower wins on conflict; managed via reorderNatMappings, not edited directly
  show_in_legend: boolean
  created_at:     string
}
export interface NatMappingIn {
  name:           string
  site_key:       string
  category:       'wan' | 'vpn'
  private_cidr:   string
  public_cidr:    string
  dst_cidrs:      string | null
  dst_ports:      string | null
  show_in_legend: boolean
}

export interface TrafficRule {
  id:                  number
  name:                string
  nat_mapping_id:      number | null   // null = applies to any NAT mapping
  dst_cidrs:           string | null   // comma-separated IPs/CIDRs, e.g. "1.1.1.1,9.9.9.9" — mutually exclusive with dst_site_key
  dst_site_key:        string | null   // live reference to a Site's ip_cidr — mutually exclusive with dst_cidrs; locked once set (see PUT /api/traffic-rules/{id})
  dst_ports:           string | null   // comma-separated ports/ranges, e.g. "53,8000-9000"
  line_style_id:       number | null
  priority:            number          // lower wins; managed via reorderTrafficRules, not edited directly
  created_at:          string
}
export interface TrafficRuleIn {
  name:               string
  nat_mapping_id:     number | null
  dst_cidrs:          string | null
  dst_site_key:       string | null
  dst_ports:          string | null
  line_style_id:      number | null
}

export interface IpInfoResult {
  ip: string
  ipinfo: Record<string, any> | null
  ipinfo_error: string | null
  ipinfo_enabled_fields: string[] | null
  ipinfo_enabled: boolean
  ipapi_is: Record<string, any> | null
  ipapi_is_error: string | null
  ipapi_is_enabled_fields: string[] | null
  ipapi_is_enabled: boolean
  abuseipdb: Record<string, any> | null
  abuseipdb_error: string | null
  abuseipdb_enabled: boolean
  mxtoolbox: Record<string, any> | null
  mxtoolbox_error: string | null
  mxtoolbox_enabled_fields: string[] | null
  mxtoolbox_enabled: boolean
  ipqualityscore: Record<string, any> | null
  ipqualityscore_error: string | null
  ipqualityscore_enabled: boolean
}

export interface AsnInfoResult {
  asn: string
  ipinfo: Record<string, any> | null
  ipinfo_error: string | null
}

export interface Integration {
  id: number
  name: string
  app_name: string
  base_url: string
  has_token: boolean
  enabled: boolean
  health_status: string
  last_health_check: string | null
}

export interface IntegrationInput {
  name: string
  app_name?: string
  base_url: string
  suite_token: string
  enabled?: boolean
}

export interface InternalIpInfoResult {
  ip: string
  configured: boolean
  found: boolean
  error: string | null
  subnet: { cidr: string; vlan_id: number | null; site: string | null; description: string | null; gateway: string | null } | null
  ip_address: { status: string; mac_address: string | null; hostname: string | null; description: string | null; owner: string | null; tags: string[] } | null
  dhcp_leases: { mac_address: string | null; hostname: string | null; state: string; starts_at: string | null; ends_at: string | null; last_seen: string }[]
  dns_records: { zone: string; name: string; record_type: string; ttl: number | null; last_seen: string }[]
  arp_entries: { device_label: string | null; mac_address: string | null; interface: string | null; vlan_tag: number | null; last_seen: string }[]
}

export interface UserApiKey {
  provider: string
  label: string
  api_key: string
  updated_at: string | null
  enabled_fields: string[] | null // ipinfo/ipapi_is/mxtoolbox only; null = not customized (all shown)
  free_tier: boolean // ipapi_is only — use its keyless free tier instead of api_key
  enabled: boolean // ipinfo/ipapi_is/abuseipdb/mxtoolbox only — show this provider's section in the IP Lookup modal at all
}

export interface Site {
  id:             number
  name:           string   // key — immutable for the Default site (name === 'default')
  display_name:   string
  fill_color:     string
  stroke_color:   string
  badge_bg:       string
  badge_text:     string
  show_in_legend: boolean
  ip_cidr:        string   // comma-separated IP/CIDR list; matches remote (public) traffic to this site
  created_at:     string
}
export interface SiteIn {
  name:           string
  display_name:   string
  fill_color:     string
  stroke_color:   string
  badge_bg:       string
  badge_text:     string
  show_in_legend: boolean
  ip_cidr:        string
}

export interface LineStyle {
  id:           number
  name:         string
  label:        string
  color_hex:    string
  dash_pattern: string
  created_at:   string
}
export interface LineStyleIn {
  name:         string
  label:        string
  color_hex:    string
  dash_pattern: string
}


export type TopologyParams = { window?: string; sampler_ip?: string; min_bytes?: string; limit?: string }
export type TimeSeriesParams = { sampler_ip?: string; window?: string; dst_port?: string; protocol?: string; site?: string }
export type TopTalkersParams = { sampler_ip?: string; window?: string; limit?: string }
export type SearchParams = {
  src_ip?: string; dst_ip?: string; src_port?: string; dst_port?: string
  protocol?: string; sampler_ip?: string; window?: string; limit?: string
  offset?: string; any_direction?: string
}
export type TopPortsParams = { window?: string; sampler_ip?: string; site?: string; limit?: string }
export type NatTranslationsParams = { window?: string; sampler_ip?: string; limit?: string }

export interface LogRecord {
  id: number
  ts: string
  level: string
  level_no: number
  logger: string
  message: string
  exc_info: string | null
}

export interface LogResponse {
  total: number
  limit: number
  offset: number
  records: LogRecord[]
}

export interface LogStats {
  total: number
  by_level: Record<string, number>
  loggers: string[]
  latest_ts: string | null
  capture_level?: string
}

export type LogQueryParams = {
  level?: string
  logger?: string
  search?: string
  since?: string
  until?: string
  limit?: string
  offset?: string
}

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
