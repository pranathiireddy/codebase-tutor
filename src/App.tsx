import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import { AppProvider } from './context/AppContext';
import { useApp } from './context/AppContext';
import { LandingPage } from './pages/LandingPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { LoginPage, SignupPage } from './pages/AuthPages';
import { DocsPage } from './pages/DocsPage';
import { SettingsPage } from './pages/SettingsPage';
import { setUnauthorizedHandler } from './utils/api';

const FEATURED_DEMO_ID = 'dietrichgebert__ponytail';

function AuthLoading() {
  return <div className="min-h-screen bg-[#0B0D10]" aria-label="Checking sign-in status" />;
}

function ProtectedRoute({ children, allowGuest = false }: { children: ReactNode; allowGuest?: boolean }) {
  const { user, authLoading } = useApp();
  const location = useLocation();
  if (authLoading) return <AuthLoading />;
  if (!user && !allowGuest) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

function AuthRedirectHandler() {
  const { setSession } = useApp();
  const navigate = useNavigate();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession(null);
      navigate('/login', { replace: true });
    });
    return () => setUnauthorizedHandler(undefined);
  }, [navigate, setSession]);

  return null;
}

function WorkspaceRoute() {
  const { user, authLoading } = useApp();
  const { repositoryId } = useParams<{ repositoryId?: string }>();
  if (authLoading) return <AuthLoading />;
  const isGuestDemo = !user && repositoryId === FEATURED_DEMO_ID;
  return (
    <ProtectedRoute allowGuest={isGuestDemo}>
      <WorkspacePage readOnly={!user} />
    </ProtectedRoute>
  );
}

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <AuthRedirectHandler />
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/workspace" element={<WorkspaceRoute />} />
          <Route path="/workspace/:repositoryId" element={<WorkspaceRoute />} />
          <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AppProvider>
  );
}
