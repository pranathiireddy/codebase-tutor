import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { LandingPage } from './pages/LandingPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { LoginPage, SignupPage } from './pages/AuthPages';
import { DocsPage } from './pages/DocsPage';
import { SettingsPage } from './pages/SettingsPage';

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/workspace" element={<WorkspacePage />} />
          <Route path="/workspace/:repositoryId" element={<WorkspacePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AppProvider>
  );
}
