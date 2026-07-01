import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './store/auth'
import Layout from './components/Layout'
import Login from './pages/Login'

import { lazy, Suspense } from 'react'
const Analytics    = lazy(() => import('./pages/Analytics'))
const GeoPage      = lazy(() => import('./pages/GeoMap').then(m => ({ default: m.GeoPage })))
const GeoMapPage   = lazy(() => import('./pages/GeoMap'))
const DeviceView   = lazy(() => import('./pages/DeviceView'))
const FlowExplorer = lazy(() => import('./pages/FlowExplorer'))
const Topology     = lazy(() => import('./pages/Topology'))
const Alerts       = lazy(() => import('./pages/Alerts'))
const Settings     = lazy(() => import('./pages/Settings'))
const Ports        = lazy(() => import('./pages/Ports'))
const Logs         = lazy(() => import('./pages/Logs'))

function PageFallback() {
  return <div className="flex items-center justify-center h-48 text-white">Loading…</div>
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth()
  if (isLoading) return <PageFallback />
  if (!user) return <Navigate to="/login" replace />
  return <Layout>{children}</Layout>
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={
            <ProtectedRoute>
              <Suspense fallback={<PageFallback />}><Analytics /></Suspense>
            </ProtectedRoute>
          } />
          <Route path="/analytics" element={<Navigate to="/" replace />} />
          <Route path="/devices/:ip?" element={
            <ProtectedRoute>
              <Suspense fallback={<PageFallback />}><DeviceView /></Suspense>
            </ProtectedRoute>
          } />
          <Route path="/explorer" element={
            <ProtectedRoute>
              <Suspense fallback={<PageFallback />}><FlowExplorer /></Suspense>
            </ProtectedRoute>
          } />
          <Route path="/geo" element={
            <ProtectedRoute>
              <Suspense fallback={<PageFallback />}><GeoPage /></Suspense>
            </ProtectedRoute>
          } />
          <Route path="/topology" element={
            <ProtectedRoute>
              <Suspense fallback={<PageFallback />}><Topology /></Suspense>
            </ProtectedRoute>
          } />
          <Route path="/alerts" element={
            <ProtectedRoute>
              <Suspense fallback={<PageFallback />}><Alerts /></Suspense>
            </ProtectedRoute>
          } />
          <Route path="/settings" element={
            <ProtectedRoute>
              <Suspense fallback={<PageFallback />}><Settings /></Suspense>
            </ProtectedRoute>
          } />
          <Route path="/users" element={<Navigate to="/settings" replace />} />
          <Route path="/ports" element={
            <ProtectedRoute>
              <Suspense fallback={<PageFallback />}><Ports /></Suspense>
            </ProtectedRoute>
          } />
          <Route path="/logs" element={
            <ProtectedRoute>
              <Suspense fallback={<PageFallback />}><Logs /></Suspense>
            </ProtectedRoute>
          } />
          {/* /geomap — fullscreen pop-out, no sidebar; manages its own auth via sessionStorage token */}
          <Route path="/geomap" element={
            <Suspense fallback={<PageFallback />}><GeoMapPage /></Suspense>
          } />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
