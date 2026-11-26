import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AppProvider } from './context/AppContext';
import { useApp } from './context/AppContext';
import { LandingPage } from './pages/LandingPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { LoginPage, SignupPage } from './pages/AuthPages';
import { DocsPage } from './pages/DocsPage';
import { SettingsPage } from './pages/SettingsPage';

const FEATURED_DEMO_ID = 'dietrichgebert__ponytail';

function AuthLoading() {
  return <div className="min-h-screen bg-[#0B0D10]" aria-label="Checking sign-in status" />;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, authLoading } = useApp();
  const location = useLocation();
  if (authLoading) return <AuthLoading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

function WorkspaceRoute() {
  const { user, authLoading } = useApp();
  const location = useLocation();
  const { repositoryId } = useParams<{ repositoryId?: string }>();
  if (authLoading) return <AuthLoading />;
  if (!user && repositoryId && repositoryId !== FEATURED_DEMO_ID) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <WorkspacePage readOnly={!user} />;
}

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/workspace" element={<WorkspaceRoute />} />
          <Route path="/workspace/:repositoryId" element={<WorkspaceRoute />} />
          <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AppProvider>
  );
}
