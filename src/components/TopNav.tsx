import { Link, useLocation } from 'react-router-dom';
import { useApp } from '../context/AppContext';

export function TopNav() {
  const location = useLocation();
  const { user, logout } = useApp();

  const isActive = (path: string) => location.pathname === path;

  return (
    <header className="sticky top-0 z-30 h-14 border-b border-[#232832] bg-[#0B0D10]/95 backdrop-blur-sm">
      <div className="mx-auto flex h-full max-w-[1400px] items-center justify-between gap-8 px-6">
        {/* Zone 1: Single-line brand wordmark */}
        <Link
          to="/"
          className="text-base font-semibold tracking-tight text-[#F3F4F6] whitespace-nowrap shrink-0 hover:text-sky-400 transition-colors"
        >
          Codebase Tutor
        </Link>

        {/* Zone 2: Concise single-line navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
          <Link
            to="/"
            className={`whitespace-nowrap shrink-0 transition-colors ${
              isActive('/') ? 'text-[#F3F4F6]' : 'text-[#9CA3AF] hover:text-[#F3F4F6]'
            }`}
          >
            Explore
          </Link>
          <Link
            to="/workspace/dietrichgebert__ponytail"
            className={`whitespace-nowrap shrink-0 transition-colors ${
              location.pathname.startsWith('/workspace') ? 'text-[#F3F4F6]' : 'text-[#9CA3AF] hover:text-[#F3F4F6]'
            }`}
          >
            Ponytail Demo
          </Link>
          <Link
            to="/docs"
            className={`whitespace-nowrap shrink-0 transition-colors ${
              isActive('/docs') ? 'text-[#F3F4F6]' : 'text-[#9CA3AF] hover:text-[#F3F4F6]'
            }`}
          >
            Documentation
          </Link>
          <Link
            to="/settings"
            className={`whitespace-nowrap shrink-0 transition-colors ${
              isActive('/settings') ? 'text-[#F3F4F6]' : 'text-[#9CA3AF] hover:text-[#F3F4F6]'
            }`}
          >
            Settings
          </Link>
          {user ? (
            <button
              type="button"
              onClick={() => void logout()}
              className="text-[#9CA3AF] hover:text-[#F3F4F6] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Sign out ({user.name.split(' ')[0]})
            </button>
          ) : (
            <Link
              to="/login"
              className={`whitespace-nowrap shrink-0 transition-colors ${
                isActive('/login') || isActive('/signup') ? 'text-[#F3F4F6]' : 'text-[#9CA3AF] hover:text-[#F3F4F6]'
              }`}
            >
              Sign in
            </Link>
          )}
        </nav>

        {/* Zone 3: Single primary action */}
        <div className="flex items-center shrink-0">
          <Link
            to="/workspace/dietrichgebert__ponytail"
            className="rounded-md bg-sky-500 px-3.5 py-1.5 text-xs font-semibold text-[#0B0D10] hover:bg-sky-400 transition-colors whitespace-nowrap shrink-0"
          >
            Open Workspace
          </Link>
        </div>
      </div>
    </header>
  );
}
